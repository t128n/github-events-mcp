import {
  defineEvent,
  type EventDefinition,
  type EventOccurrence,
  type EventPollResult,
  type PollContext,
} from "@github-events-mcp/events";
import { subscribedHosts, type Config, type GithubEventName } from "../config/config.ts";
import { githubStatePath } from "../config/home.ts";
import type { EventSource } from "../daemon/source.ts";
import {
  allowedByConfig,
  decodeCursor,
  encodeCursor,
  eventMatchesArguments,
  mapNotification,
  pollHost,
  type CompositeCursor,
  type GithubEventData,
  type HostCursor,
} from "./notifications.ts";
import { ProcessGhRunner, type GhRunner } from "./runner.ts";
import { readGithubState, writeGithubState, type GithubState, type HostStatus } from "./state.ts";

export const GITHUB_GROUP = "github.notifications";

export interface GithubSourceOptions {
  runner?: GhRunner;
  stateFile?: string;
  now?: () => number;
  /** How long an authentication failure pauses a host before trying again. */
  pausedRetryMs?: number;
  log?: (message: string) => void;
}

export interface GithubSource extends EventSource {
  /** Read-only status for `/health` and `doctor`, without payloads or tokens. */
  status: () => { hosts: number; paused: number; lastPollAt?: string };
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    repos: {
      type: "array",
      items: { type: "string" },
      maxItems: 50,
      description: "Only these repositories (owner/repo or owner/*).",
    },
    reasons: {
      type: "array",
      items: { type: "string" },
      maxItems: 20,
      description: "Only these GitHub notification reasons (for example review_requested).",
    },
  },
  additionalProperties: false,
};

const PAYLOAD_SCHEMA = {
  type: "object",
  properties: {
    host: { type: "string" },
    repo: { type: "string" },
    reason: { type: "string" },
    subjectType: { type: "string" },
    title: { type: "string" },
    url: { type: "string", format: "uri" },
    updatedAt: { type: "string", format: "date-time" },
    threadId: { type: "string" },
  },
  required: ["host", "repo", "reason", "subjectType", "title", "url", "updatedAt", "threadId"],
  additionalProperties: false,
};

/**
 * All GitHub event types share one group and one loop. The loop calls `gh` once per subscribed
 * host per interval; the events layer filters occurrences per stream by name and arguments.
 */
export function createGithubSource(config: Config, options: GithubSourceOptions = {}): GithubSource {
  const runner = options.runner ?? new ProcessGhRunner();
  const now = options.now ?? Date.now;
  const stateFile = options.stateFile ?? githubStatePath();
  const floorMs = config.pollFloorSeconds * 1000;
  const pausedRetryMs = options.pausedRetryMs ?? 15 * 60_000;
  const log = options.log ?? (() => {});
  const hosts = subscribedHosts(config);
  const state = readGithubState(stateFile);

  const persist = (): void => {
    try {
      writeGithubState(state, stateFile);
    } catch (error) {
      log(`could not save the GitHub host state: ${(error as Error).message}`);
    }
  };

  const poll = async (cursor: string | null, _args: Record<string, unknown>, context: PollContext): Promise<EventPollResult> => {
    if (!hosts.length) return { events: [], cursor, hasMore: false, nextPollMs: floorMs };

    const decoded = decodeCursor(cursor);
    const malformed = cursor !== null && decoded === undefined;
    const composite: CompositeCursor = decoded ?? { v: 1, hosts: {} };
    const collected = new Map<string, EventOccurrence<GithubEventData>>();
    const errors: NonNullable<EventPollResult["errors"]> = [];
    const intervals: number[] = [];
    let truncated = malformed;
    let more = false;

    for (const host of hosts) {
      const status = state.hosts[host] ?? { paused: false };
      const paused = isPaused(status, now(), pausedRetryMs);
      if (paused) {
        intervals.push(pausedRetryMs);
        errors.push({
          code: -32024,
          message: "Forbidden",
          data: {
            host,
            reason: "host paused after an authentication failure; run gh auth login --hostname " + host,
          },
        });
        continue;
      }

      let hostCursor: HostCursor | undefined = composite.hosts[host];
      const baseline = !hostCursor;
      if (!hostCursor) hostCursor = { since: new Date(now()).toISOString() };
      status.lastPollAt = new Date(now()).toISOString();

      try {
        const result = await pollHost({
          runner,
          host,
          cursor: hostCursor,
          floorMs,
          participatingOnly: config.participatingOnly,
          signal: context.signal,
          now,
        });
        composite.hosts[host] = result.cursor;
        intervals.push(result.nextPollMs);
        if (result.hasMore) more = true;
        status.lastSuccessAt = new Date(now()).toISOString();
        status.paused = false;
        status.lastError = undefined;
        status.nextPollAt = new Date(now() + result.nextPollMs).toISOString();
        if (baseline) continue;

        for (const notification of result.notifications) {
          const occurrence = mapNotification(host, notification);
          if (!occurrence) continue;
          if (!allowedByConfig(config, host, notification, occurrence.name as GithubEventName)) continue;
          collected.set(occurrence.eventId, occurrence);
        }
      } catch (error) {
        status.lastError = { message: (error as Error).message, at: new Date(now()).toISOString() };
        if (isAuthError(error)) {
          status.paused = true;
          intervals.push(pausedRetryMs);
          errors.push({
            code: -32024,
            message: "Forbidden",
            data: {
              host,
              reason: "authentication failed; run gh auth login --hostname " + host,
            },
          });
        } else if (isRateLimit(error)) {
          const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs ?? 60_000;
          intervals.push(retryAfterMs);
          errors.push({
            code: -32603,
            message: "UpstreamRateLimited",
            data: { host, retryAfterMs },
          });
        } else {
          intervals.push(floorMs);
          errors.push({
            code: -32603,
            message: "UpstreamError",
            data: { host, reason: (error as Error).message },
          });
        }
      } finally {
        state.hosts[host] = status;
      }
    }

    persist();
    if (more) truncated = true;
    const events = [...collected.values()].sort((a, b) =>
      a.timestamp === b.timestamp ? a.eventId.localeCompare(b.eventId) : a.timestamp.localeCompare(b.timestamp),
    );
    let limited = events;
    if (limited.length > context.maxEvents) {
      limited = limited.slice(0, context.maxEvents);
      truncated = true;
    }
    const nextPollMs = Math.max(floorMs, intervals.length ? Math.min(...intervals) : floorMs);
    return {
      events: limited,
      cursor: encodeCursor({ v: 1, hosts: composite.hosts }),
      hasMore: false,
      nextPollMs,
      truncated,
      ...(errors.length ? { errors } : {}),
    };
  };

  const events = EVENT_TYPES.map((event) =>
    defineEvent<Record<string, unknown>, GithubEventData>({
      name: event.name,
      description: event.description,
      group: GITHUB_GROUP,
      shared: true,
      inputSchema: INPUT_SCHEMA,
      payloadSchema: PAYLOAD_SCHEMA,
      filter: (occurrence, args) => eventMatchesArguments(occurrence.data, args),
      poll,
    }),
  ) as EventDefinition<any, any>[];

  return {
    events,
    status: () => {
      const statuses = hosts.map((host) => state.hosts[host]).filter((status): status is HostStatus => !!status);
      const paused = statuses.filter((status) => isPaused(status, now(), pausedRetryMs)).length;
      const times = statuses.map((status) => status.lastSuccessAt).filter((value): value is string => !!value).sort();
      return { hosts: hosts.length, paused, lastPollAt: times[times.length - 1] };
    },
    health: () => {
      const statuses = hosts.map((host) => state.hosts[host]).filter((status): status is HostStatus => !!status);
      const paused = statuses.filter((status) => isPaused(status, now(), pausedRetryMs)).length;
      const times = statuses.map((status) => status.lastSuccessAt).filter((value): value is string => !!value).sort();
      return { github: { hosts: hosts.length, paused, lastPollAt: times[times.length - 1] } };
    },
  };
}

interface EventTypeDescription {
  name: GithubEventName;
  description: string;
}

const EVENT_TYPES: EventTypeDescription[] = [
  { name: "github.pr.review_requested", description: "A review was requested from you or your team." },
  { name: "github.pr.comment", description: "A pull request you participate in or watch got a comment." },
  {
    name: "github.pr.ci_failed",
    description:
      "A workflow run you triggered or watched completed. GitHub does not say pass/fail in the notification; see docs/notifications.md.",
  },
  { name: "github.issue.assigned", description: "An issue was assigned to you." },
  { name: "github.issue.comment", description: "An issue you participate in or watch got a comment." },
  { name: "github.mention", description: "You or a team you are on were mentioned." },
];

function isPaused(status: HostStatus, now: number, pausedRetryMs: number): boolean {
  if (!status.paused) return false;
  if (!status.lastError) return true;
  const failedAt = Date.parse(status.lastError.at);
  return !Number.isFinite(failedAt) || now - failedAt < pausedRetryMs;
}

function isAuthError(error: unknown): boolean {
  return (error as { name?: string })?.name === "GhAuthError";
}

function isRateLimit(error: unknown): boolean {
  return (error as { name?: string })?.name === "GhRateLimitError";
}

export type { GithubState };
