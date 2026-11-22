import type { ProcessRunner } from "../platform/process.ts";

export interface GhHost {
  host: string;
  login?: string;
  state: string;
  active: boolean;
  scopes?: string;
}

export interface GhAccount {
  state?: string;
  active?: boolean;
  host?: string;
  login?: string;
  scopes?: string;
}

/** `gh auth status --json hosts`, flattened. Throws when gh is missing or the output is unusable. */
export async function listGhHosts(runner: ProcessRunner): Promise<GhHost[]> {
  const result = await runner.run(["gh", "auth", "status", "--json", "hosts"], { timeoutMs: 15_000 });
  if (result.code !== 0) {
    throw new Error(`gh auth status failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
  }
  const parsed = JSON.parse(result.stdout) as { hosts?: Record<string, GhAccount[]> };
  const hosts: GhHost[] = [];
  for (const [host, accounts] of Object.entries(parsed.hosts ?? {})) {
    const account = accounts.find((item) => item.active) ?? accounts[0];
    if (!account) continue;
    hosts.push({
      host: host.toLowerCase(),
      login: account.login,
      state: account.state ?? "unknown",
      active: account.active === true,
      scopes: account.scopes,
    });
  }
  hosts.sort((a, b) => a.host.localeCompare(b.host));
  return hosts;
}

export async function ghVersion(runner: ProcessRunner): Promise<string | undefined> {
  const result = await runner.run(["gh", "--version"], { timeoutMs: 10_000 });
  if (result.code !== 0) return undefined;
  return /gh version\s+([0-9][0-9A-Za-z.+-]*)/i.exec(result.stdout)?.[1];
}

/** Compare `2.101.0` with `2.40.0`; non-numeric suffixes are ignored. */
export function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string) => value.split("-")[0]!.split(".").map((part) => Number(part.replace(/\D.*$/, "")) || 0);
  const left = parse(actual);
  const right = parse(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

export const MINIMUM_GH_VERSION = "2.40.0";

/** Scopes are a comma-separated list in `X-Oauth-Scopes`. */
export function hasNotificationScope(scopes: string | undefined): boolean {
  if (!scopes) return false;
  const list = scopes.split(/[,\s]+/).map((scope) => scope.trim().toLowerCase());
  return list.includes("notifications") || list.includes("repo");
}
