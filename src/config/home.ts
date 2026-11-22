import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The folder name on Windows and the program name everywhere. */
export const APP_NAME = "GitHub Events MCP";
export const APP_DIR = "github-events-mcp";
export const EXE_NAME = process.platform === "win32" ? "github-events-mcp.exe" : "github-events-mcp";

/**
 * `GITHUB_EVENTS_MCP_HOME` puts config and state in one directory, which is what tests use.
 * Otherwise Windows gets `%LOCALAPPDATA%\GitHubEventsMCP`, and other systems follow the XDG
 * base directories so development on macOS and Linux does not litter the home directory.
 */
export function configDir(): string {
  if (process.env.GITHUB_EVENTS_MCP_HOME) return process.env.GITHUB_EVENTS_MCP_HOME;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (!local) throw new Error("LOCALAPPDATA is not set");
    return join(local, "GitHubEventsMCP");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), APP_DIR);
}

export function stateDir(): string {
  if (process.env.GITHUB_EVENTS_MCP_STATE_HOME) return process.env.GITHUB_EVENTS_MCP_STATE_HOME;
  if (process.env.GITHUB_EVENTS_MCP_HOME) return process.env.GITHUB_EVENTS_MCP_HOME;
  if (process.platform === "win32") return configDir();
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), APP_DIR);
}

export const configPath = (): string => join(configDir(), "config.json");
export const tokenPath = (): string => join(configDir(), "token");
export const statePath = (): string => join(stateDir(), "state.json");
export const githubStatePath = (): string => join(stateDir(), "github-state.json");
export const installDir = (): string => join(configDir(), "bin");
export const installedExe = (): string => join(installDir(), EXE_NAME);

export function ensureDir(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode });
}

export function writeSecret(path: string, value: string): void {
  ensureDir(join(path, ".."));
  writeFileSync(path, value, { mode: 0o600 });
  makeUserOnly(path);
}

export function readSecret(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8").trim() || undefined;
}

export function writeJson(path: string, value: unknown): void {
  ensureDir(join(path, ".."));
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  makeUserOnly(tmp);
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  makeUserOnly(path);
}

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  let text = readFileSync(path, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/** `mode & 0o077` on POSIX; `undefined` when the platform has no such bit. */
export function permissionBits(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  if (process.platform === "win32") return undefined;
  return statSync(path).mode & 0o777;
}

export function makeUserOnly(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows maps chmod to the read-only bit; the ACL is already the user's.
  }
}
