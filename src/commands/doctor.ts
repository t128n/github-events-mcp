import { configPath, githubStatePath, permissionBits, readSecret, tokenPath } from "../config/home.ts";
import { readConfig, type Config } from "../config/config.ts";
import { booleanFlag, fail, out, parseFlags } from "../cli.ts";
import { APP_DESCRIPTION } from "../cli.ts";
import { MINIMUM_GH_VERSION, ghVersion, hasNotificationScope, listGhHosts, versionAtLeast } from "../platform/gh.ts";
import { header, headerNumber, parseHttpExchange } from "../platform/httpText.ts";
import { processRunner, type ProcessRunner } from "../platform/process.ts";
import { createScheduler, type Scheduler } from "../platform/index.ts";
import { portFree } from "./setup.ts";
import { readGithubState } from "../github/state.ts";

type Level = "pass" | "fail" | "skip";

interface Check {
  name: string;
  level: Level;
  detail: string;
  fix?: string;
}

export interface DoctorOptions {
  runner?: ProcessRunner;
  scheduler?: Scheduler;
  configFile?: string;
  tokenFile?: string;
  fetchHealth?: (port: number) => Promise<{ ok: boolean; body?: any }>;
  githubStateFile?: string;
  offline?: boolean;
}

const FLAGS = {
  json: { type: "boolean", description: "print the checks as JSON" },
  offline: { type: "boolean", description: "skip the read-only GitHub calls" },
} as const;

export async function doctorCommand(args: string[], options: DoctorOptions = {}): Promise<number> {
  const parsed = parseFlags("doctor", FLAGS, args);
  if (typeof parsed === "number") return parsed;
  if (parsed.positionals.length) return fail("doctor takes no arguments");
  const checks = await runDoctor({ ...options, offline: booleanFlag(parsed.values, "offline") || options.offline });
  if (booleanFlag(parsed.values, "json")) {
    out(JSON.stringify(checks, null, 2));
  } else {
    for (const check of checks) {
      out(`${check.level.toUpperCase().padEnd(4)}  ${check.name}: ${check.detail}`);
      if (check.fix) out(`      fix: ${check.fix}`);
    }
    const failed = checks.filter((check) => check.level === "fail").length;
    out("");
    out(failed ? `${failed} check(s) failed.` : "All checks passed.");
  }
  return checks.some((check) => check.level === "fail") ? 1 : 0;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<Check[]> {
  const runner = options.runner ?? processRunner;
  const scheduler = options.scheduler ?? createScheduler();
  const configFile = options.configFile ?? configPath();
  const tokenFile = options.tokenFile ?? tokenPath();
  const checks: Check[] = [];

  let config: Config | undefined;
  try {
    config = readConfig(configFile);
    checks.push(
      config
        ? { name: "config", level: "pass", detail: `${configFile} is valid` }
        : { name: "config", level: "fail", detail: `no config at ${configFile}`, fix: "run: github-events-mcp setup" },
    );
  } catch (error) {
    checks.push({ name: "config", level: "fail", detail: (error as Error).message, fix: "fix the JSON or run setup --force" });
  }

  const token = readSecret(tokenFile);
  if (!token) {
    checks.push({ name: "token", level: "fail", detail: `no token at ${tokenFile}`, fix: "run: github-events-mcp setup" });
  } else {
    const mode = permissionBits(tokenFile);
    if (mode !== undefined && (mode & 0o077) !== 0) {
      checks.push({
        name: "token permission",
        level: "fail",
        detail: `${tokenFile} is readable by other users (mode ${mode.toString(8)})`,
        fix: process.platform === "win32" ? "reset the file ACL to the current user" : `chmod 600 "${tokenFile}"`,
      });
    } else {
      checks.push({ name: "token permission", level: "pass", detail: "readable by the current user only" });
    }
  }

  const version = await ghVersion(runner);
  if (!version) {
    checks.push({ name: "gh", level: "fail", detail: "gh is not on PATH or does not run", fix: "install the GitHub CLI: https://cli.github.com" });
  } else if (!versionAtLeast(version, MINIMUM_GH_VERSION)) {
    checks.push({
      name: "gh",
      level: "fail",
      detail: `gh ${version} is older than ${MINIMUM_GH_VERSION}`,
      fix: "upgrade the GitHub CLI",
    });
  } else {
    checks.push({ name: "gh", level: "pass", detail: `gh ${version}` });
  }

  const hosts = config?.hosts ?? ["github.com"];
  let authHosts: Set<string> | undefined;
  if (version) {
    try {
      const found = await listGhHosts(runner);
      authHosts = new Set(found.filter((host) => host.state === "success").map((host) => host.host));
      for (const host of hosts) {
        checks.push(
          authHosts.has(host)
            ? { name: `gh auth ${host}`, level: "pass", detail: found.find((item) => item.host === host)?.login ? `signed in as ${found.find((item) => item.host === host)!.login}` : "signed in" }
            : { name: `gh auth ${host}`, level: "fail", detail: "not signed in", fix: `gh auth login --hostname ${host}` },
        );
      }
    } catch (error) {
      checks.push({ name: "gh auth", level: "fail", detail: (error as Error).message, fix: "run: gh auth login" });
    }
  }

  if (options.offline) {
    checks.push({ name: "notifications", level: "skip", detail: "skipped (--offline)" });
    checks.push({ name: "rate limit", level: "skip", detail: "skipped (--offline)" });
  } else if (version) {
    for (const host of hosts) {
      if (authHosts && !authHosts.has(host)) {
        checks.push({ name: `notifications ${host}`, level: "skip", detail: "skipped: not signed in" });
        continue;
      }
      try {
        const result = await runner.run(
          ["gh", "api", "-i", "--hostname", host, "/notifications?all=false&per_page=1"],
          { timeoutMs: 20_000 },
        );
        const exchange = parseHttpExchange(result.stdout);
        if (exchange.status !== 200 && exchange.status !== 304) {
          const fix =
            exchange.status === 401 || exchange.status === 403
              ? `gh auth login --hostname ${host}; the token needs the notifications or repo scope`
              : `check the host and the network, then retry`;
          checks.push({ name: `notifications ${host}`, level: "fail", detail: `HTTP ${exchange.status || result.code}`, fix });
          continue;
        }
        checks.push({ name: `notifications ${host}`, level: "pass", detail: `HTTP ${exchange.status}, X-Poll-Interval ${header(exchange, "x-poll-interval") ?? "not sent"}` });
        const scopes = header(exchange, "x-oauth-scopes");
        checks.push(
          hasNotificationScope(scopes)
            ? { name: `scopes ${host}`, level: "pass", detail: scopes ?? "not reported" }
            : { name: `scopes ${host}`, level: "fail", detail: `no notifications or repo scope (${scopes ?? "not reported"})`, fix: `gh auth refresh --hostname ${host} --scopes repo` },
        );
        const remaining = headerNumber(exchange, "x-ratelimit-remaining");
        if (remaining !== undefined && remaining <= 10) {
          checks.push({ name: `rate limit ${host}`, level: "fail", detail: `${remaining} requests left`, fix: "wait for the reset, or lower the poll rate" });
        } else {
          checks.push({ name: `rate limit ${host}`, level: "pass", detail: remaining === undefined ? "not reported" : `${remaining} requests left` });
        }
      } catch (error) {
        checks.push({ name: `notifications ${host}`, level: "fail", detail: (error as Error).message, fix: "check gh and the network" });
      }
    }
  }

  try {
    const github = readGithubState(options.githubStateFile ?? githubStatePath());
    const paused = Object.entries(github.hosts).filter(([, status]) => status.paused);
    if (paused.length) {
      checks.push({
        name: "github host state",
        level: "fail",
        detail: `${paused.map(([host]) => host).join(", ")} paused after an authentication failure`,
        fix: "run gh auth login for that host, then restart the daemon",
      });
    } else {
      const times = Object.values(github.hosts)
        .map((status) => status.lastSuccessAt)
        .filter((value): value is string => !!value)
        .sort();
      checks.push({ name: "github host state", level: "pass", detail: times.length ? `last successful poll ${times[times.length - 1]}` : "no poll recorded yet" });
    }
  } catch (error) {
    checks.push({ name: "github host state", level: "fail", detail: (error as Error).message, fix: "check the state file permissions" });
  }

  if (config) {
    const port = config.port;
    const health = await (options.fetchHealth ?? fetchHealth)(port);
    if (health.ok) {
      checks.push({ name: "health", level: "pass", detail: `daemon answers on 127.0.0.1:${port}` });
      checks.push({ name: "port", level: "pass", detail: `owned by this daemon` });
    } else {
      checks.push({
        name: "health",
        level: "fail",
        detail: "the daemon does not answer",
        fix: process.platform === "win32" ? "run: github-events-mcp install (or serve in a terminal)" : "run: github-events-mcp serve",
      });
      if (!(await portFree(port))) {
        checks.push({ name: "port", level: "fail", detail: `127.0.0.1:${port} is used by another program`, fix: "change the port in the config" });
      } else {
        checks.push({ name: "port", level: "pass", detail: `127.0.0.1:${port} is free` });
      }
    }
  }

  if (!scheduler.supported) {
    checks.push({ name: "logon task", level: "skip", detail: "only available on Windows" });
  } else {
    const task = scheduler.query();
    if (!task.installed) {
      checks.push({ name: "logon task", level: "fail", detail: "not installed", fix: "run: github-events-mcp install" });
    } else if (task.lastResult !== undefined && task.lastResult !== 0) {
      checks.push({ name: "logon task", level: "fail", detail: `last run failed with code ${task.lastResult}`, fix: "run: github-events-mcp doctor, then install" });
    } else {
      checks.push({ name: "logon task", level: "pass", detail: `installed and ${task.enabled ? "enabled" : "disabled"}` });
    }
  }

  return checks;
}

async function fetchHealth(port: number): Promise<{ ok: boolean; body?: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!response.ok) return { ok: false };
    const body = await response.json();
    return { ok: (body as any)?.name === APP_DESCRIPTION, body };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export type { Check };
