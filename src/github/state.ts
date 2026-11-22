import { existsSync } from "node:fs";
import { githubStatePath, readJson, writeJson } from "../config/home.ts";

export interface HostStatus {
  paused: boolean;
  lastPollAt?: string;
  lastSuccessAt?: string;
  lastError?: { message: string; at: string };
  nextPollAt?: string;
}

export interface GithubState {
  version: 1;
  hosts: Record<string, HostStatus>;
}

export const emptyGithubState = (): GithubState => ({ version: 1, hosts: {} });

export function readGithubState(path = githubStatePath()): GithubState {
  if (!existsSync(path)) return emptyGithubState();
  try {
    const value = readJson<Partial<GithubState>>(path);
    if (!value || value.version !== 1 || typeof value.hosts !== "object" || value.hosts === null) return emptyGithubState();
    return { version: 1, hosts: value.hosts };
  } catch {
    return emptyGithubState();
  }
}

export function writeGithubState(state: GithubState, path = githubStatePath()): void {
  writeJson(path, state);
}
