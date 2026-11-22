import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import {
  configPath,
  ensureDir,
  readSecret,
  tokenPath,
  writeSecret,
} from "../config/home.ts";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  GITHUB_EVENT_NAMES,
  addSubscription,
  defaultConfig,
  normalizeEvents,
  readConfig,
  saveConfig,
  type Config,
  type Subscription,
} from "../config/config.ts";
import { ask, booleanFlag, fail, listFlag, out, parseFlags, stringFlag, type FlagValues } from "../cli.ts";
import { listGhHosts } from "../github/gh.ts";
import { processRunner, type ProcessRunner } from "../platform/process.ts";

const FLAGS = {
  host: { type: "string", multiple: true, arg: "host", description: "host to watch; repeat or comma-separate (default: github.com)" },
  port: { type: "string", arg: "port", description: "local port for the daemon" },
  "poll-floor": { type: "string", arg: "seconds", description: "minimum seconds between polls (default 60)" },
  all: { type: "boolean", description: "include all notifications, not only participating ones" },
  subscribe: { type: "string", multiple: true, arg: "owner/repo", description: "watch this repository or owner/* (repeatable)" },
  events: { type: "string", arg: "a,b", description: "event types for the repositories given with --subscribe (default: all)" },
  "reset-token": { type: "boolean", description: "generate a new bearer token" },
  force: { type: "boolean", description: "replace an existing config, including subscriptions" },
} as const;

export interface SetupOptions {
  runner?: ProcessRunner;
  interactive?: boolean;
  configFile?: string;
  tokenFile?: string;
}

export async function setupCommand(args: string[], options: SetupOptions = {}): Promise<number> {
  const parsed = parseFlags("setup", FLAGS, args);
  if (typeof parsed === "number") return parsed;
  return runSetup(parsed.values, parsed.positionals, options);
}

export async function runSetup(values: FlagValues, positionals: string[], options: SetupOptions = {}): Promise<number> {
  if (positionals.length) return fail("setup takes no arguments");
  const configFile = options.configFile ?? configPath();
  const tokenFile = options.tokenFile ?? tokenPath();
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY);
  let existing: Config | undefined;
  try {
    existing = readConfig(configFile);
  } catch (error) {
    if (!booleanFlag(values, "force")) return fail(`${(error as Error).message}; fix it or pass --force`);
  }
  if (booleanFlag(values, "force")) existing = undefined;

  let hosts = listFlag(values, "host");
  if (!hosts.length && existing) hosts = existing.hosts;
  if (!hosts.length) {
    let found;
    try {
      found = await listGhHosts(options.runner ?? processRunner);
    } catch (error) {
      return fail(`${(error as Error).message}\nInstall the GitHub CLI and sign in: gh auth login`);
    }
    const usable = found.filter((host) => host.state === "success").map((host) => host.host);
    if (!usable.length) return fail("gh is not signed in to any host; run: gh auth login");
    if (interactive) {
      out("Signed in to:");
      for (const host of found) out(`  ${host.host}${host.login ? ` (${host.login})` : ""}  ${host.state}`);
      const answer = await ask("Hosts to watch (comma separated)", usable.includes(DEFAULT_HOST) ? DEFAULT_HOST : usable[0]!);
      hosts = answer.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
    } else {
      hosts = [usable.includes(DEFAULT_HOST) ? DEFAULT_HOST : usable[0]!];
    }
  }
  hosts = [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))];
  if (!hosts.length) return fail("at least one host is required");

  let port: number;
  try {
    port = Number(stringFlag(values, "port", String(existing?.port ?? 0)));
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be between 1 and 65535");
  } catch (error) {
    return fail((error as Error).message);
  }
  if (!port) port = await choosePort(DEFAULT_PORT);
  else if (!(await portFree(port))) {
    const fallback = await choosePort(0);
    out(`Port ${port} is in use; using ${fallback} instead.`);
    port = fallback;
  }

  let floor: number;
  try {
    floor = Number(stringFlag(values, "poll-floor", String(existing?.pollFloorSeconds ?? 60)));
    if (!Number.isInteger(floor) || floor < 10 || floor > 3600) throw new Error("poll floor must be between 10 and 3600 seconds");
  } catch (error) {
    return fail((error as Error).message);
  }

  let subscriptions: Subscription[] = existing?.subscriptions ? [...existing.subscriptions] : [];
  const hostFlag = listFlag(values, "host").length > 0;
  if (hostFlag) subscriptions = subscriptions.filter((subscription) => hosts.includes(subscription.host));
  const repos = listFlag(values, "subscribe");
  let events;
  try {
    events = normalizeEvents(listFlag(values, "events"));
  } catch (error) {
    return fail((error as Error).message);
  }
  for (const repo of repos) {
    subscriptions.push({ host: hosts[0]!, repo, ...(events ? { events } : {}) });
  }
  if (!repos.length && interactive && !existing) {
    out(`Event types: ${GITHUB_EVENT_NAMES.join(", ")}`);
    const answer = await ask("Repositories to watch now (owner/repo or owner/*, comma separated, blank for none)");
    const chosen = answer.split(",").map((item) => item.trim()).filter(Boolean);
    for (const repo of chosen) subscriptions.push({ host: hosts[0]!, repo });
  }

  let config: Config;
  try {
    config = {
      ...(existing ?? defaultConfig()),
      hosts,
      defaultHost: hosts.includes(DEFAULT_HOST) ? DEFAULT_HOST : hosts[0]!,
      port,
      pollFloorSeconds: floor,
      participatingOnly: booleanFlag(values, "all") ? false : (existing?.participatingOnly ?? true),
      subscriptions: [],
    };
    for (const subscription of subscriptions) config = addSubscription(config, subscription);
    saveConfig(config, configFile);
  } catch (error) {
    return fail(`could not write the config: ${(error as Error).message}`);
  }

  ensureDir(dirname(configFile));
  let token = values["reset-token"] ? undefined : readSecret(tokenFile);
  const generated = !token;
  if (!token) {
    token = randomBytes(32).toString("base64url");
    writeSecret(tokenFile, token);
  }

  out(`Config written to ${configFile}`);
  out(`Watching hosts: ${config.hosts.join(", ")}`);
  out(`Local port: ${config.port}`);
  out(`Poll floor: ${config.pollFloorSeconds}s${config.participatingOnly ? " (participating notifications only)" : ""}`);
  out(`Token ${generated ? "generated" : "kept"} at ${tokenFile}`);
  if (!config.subscriptions.length) out("Nothing is watched yet. Add a subscription with: github-events-mcp subscribe owner/repo");
  out("");
  out("MCP client snippet (OpenCode, Streamable HTTP):");
  out(mcpSnippet(config.port, token));
  out("");
  out("Next: github-events-mcp doctor");
  return 0;
}

export function mcpSnippet(port: number, token: string): string {
  return JSON.stringify(
    {
      mcp: {
        "github-events": {
          type: "remote",
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
          protocol: "2026-07-28",
        },
      },
    },
    null,
    2,
  );
}

export async function portFree(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("") });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

export async function choosePort(preferred: number): Promise<number> {
  if (preferred > 0 && (await portFree(preferred))) return preferred;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = server.port ?? 0;
  server.stop(true);
  return port;
}

function safeReadConfig(path: string): Config | undefined {
  try {
    return readConfig(path);
  } catch {
    return undefined;
  }
}
