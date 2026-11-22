import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EventOccurrence } from "./types.ts";

/** What survives a restart for one shared poll loop. */
export interface StoredGroup {
  key: string;
  name: string;
  group: string;
  arguments: Record<string, unknown>;
  cursor: string | null;
  /** Occurrences polled but not yet handed to a stream. Bounded by the hub. */
  pending: EventOccurrence[];
  /** Recent event ids, so a restart cannot emit one twice. */
  seen: string[];
  truncated: boolean;
  updatedAt: string;
  lastPollAt?: string;
  lastError?: { message: string; at: string };
}

export interface StoredState {
  version: 1;
  groups: Record<string, StoredGroup>;
}

export interface StateStore {
  load(): StoredState;
  save(state: StoredState): void;
}

export const emptyState = (): StoredState => ({ version: 1, groups: {} });

/** A JSON file written atomically with user-only permissions. Missing or broken state is empty. */
export class FileStateStore implements StateStore {
  constructor(private readonly path: string) {}

  load(): StoredState {
    if (!existsSync(this.path)) return emptyState();
    try {
      let text = readFileSync(this.path, "utf8");
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const parsed = JSON.parse(text) as Partial<StoredState>;
      if (parsed.version !== 1 || typeof parsed.groups !== "object" || parsed.groups === null) return emptyState();
      return { version: 1, groups: parsed.groups as Record<string, StoredGroup> };
    } catch {
      // A corrupt cache is a cache miss, not a reason to refuse to start.
      return emptyState();
    }
  }

  save(state: StoredState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    try {
      renameSync(tmp, this.path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
}

/** Tests use this so they never touch the real home directory. */
export class MemoryStateStore implements StateStore {
  private state: StoredState;
  saves = 0;

  constructor(initial: StoredState = emptyState()) {
    this.state = structuredClone(initial);
  }

  load(): StoredState {
    return structuredClone(this.state);
  }

  save(state: StoredState): void {
    this.saves++;
    this.state = structuredClone(state);
  }
}
