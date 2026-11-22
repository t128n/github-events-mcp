import {
  defineEvent,
  type EventDefinition,
  type EventOccurrence,
  type EventPollResult,
  type PollContext,
} from "@github-events-mcp/events";
import { matchesAnySubscription, subscribedHosts, type Config, type GithubEventName } from "../config/config.ts";
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
import {
  ciMatches,
  createdMatches,
  createRepoDiscovery,
  decodeRepoCursor,
  encodeRepoCursor,
  pollCi,
  pollCreated,
  reposForEvent,
  type CiCursor,
  type CiData,
  type CreatedCursor,
  type CreatedData,
  type RepoCursor,
  type RepoRef,
} from "./repos.ts";
import { ProcessGhRunner, type GhRunner } from "./runner.ts";
import { readGithubState, writeGithubState, type GithubState, type HostStatus } from "./state.ts";

export const GITHUB_GROUP = "github.notifications";
export const GITHUB_REPO_GROUP = "github.repo-events";

export interface GithubSourceOptions {
  runner?: GhRunner;
  stateFile?: string;
  now?: () => number;
  /** How long an authentication failure pauses a host before trying again. */
  pausedRetryMs?: number;
  /** How long the `owner/*` repository list is cached. */
  repoRefreshMs?: number;
  /** Cap per wildcard owner. */
  maxReposPerOwner?: number;
  /** Overlap for created/CI cursors, so a same-second item is not missed. */
  overlapMs?: number;
  log?: (message: string) => void;
}

export interface GithubSource extends EventSource {
  /** Read-only status for `/health` and `doctor`, without payloads or tokens. */
  status: () => { hosts: number; paused: number; lastPollAt?: string };
}

const NOTIFICATION_EVENT_NAMES = new Set<GithubEventName>([
  "github.pr.review_requested",
  "github.pr.comment",
  "github.pr.ci_failed",
  "github.issue.assigned",
  "github.issue.comment",
  "github.mention",
]);

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

const CREATED_INPUT_SCHEMA = {
  type: "object",
  properties: {
    repos: { type: "array", items: { type: "string" }, maxItems: 50, description: "Only these repositories (owner/repo or owner/*)." },
    authors: { type: "array", items: { type: "string" }, maxItems: 50, description: "Only these authors (login or a * glob)." },
  },
  additionalProperties: false,
};

const CREATED_PAYLOAD_SCHEMA = {
  type: "object",
  properties: {
    host: { type: "string" },
    repo: { type: "string" },
    number: { type: "integer" },
    title: { type: "string" },
    url: { type: "string", format: "uri" },
    author: { type: "string" },
    subjectType: { type: "string", enum: ["Issue", "PullRequest"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["host", "repo", "number", "title", "url", "author", "subjectType", "createdAt", "updatedAt"],
  additionalProperties: false,
};

const CI_INPUT_SCHEMA = {
  type: "object",
  properties: {
    repos: { type: "array", items: { type: "string" }, maxItems: 50 },
    branches: { type: "array", items: { type: "string" }, maxItems: 50, description: "Only these branches (main or release/*)." },
    workflows: { type: "array", items: { type: "string" }, maxItems: 50, description: "Only these workflow names (CI or Build *)." },
    conclusions: {
      type: "array",
      items: { type: "string" },
      maxItems: 10,
      description: "Only these conclusions (failure, timed_out, action_required, startup_failure).",
    },
  },
  additionalProperties: false,
};

const CI_PAYLOAD_SCHEMA = {
  type: "object",
  properties: {
    host: { type: "string" },
    repo: { type: "string" },
    branch: { type: "string" },
    workflow: { type: "string" },
    conclusion: { type: "string" },
    event: { type: "string" },
    runId: { type: "string" },
    attempt: { type: "integer" },
    url: { type: "string", format: "uri" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["host", "repo", "branch", "workflow", "conclusion", "event", "runId", "attempt", "url", "updatedAt"],
  additionalProperties: false,
};

/**
 * Two groups: the notifications poll (one per host) and the repository poll (created items and
 * branch CI, one request per repository and API). The events layer filters per stream.
 */
export function createGithubSource(config: Config, options: GithubSourceOptions = {}): GithubSource {
  const runner = options.runner ?? new ProcessGhRunner();
  const now = options.now ?? Date.now;
  const stateFile = options.stateFile ?? githubStatePath();
  const floorMs = config.pollFloorSeconds * 1000;
  const pausedRetryMs = options.pausedRetryMs ?? 15 * 60_000;
  const overlapMs = options.overlapMs ?? 10 * 60_000;
  const log = options.log ?? (() => {});
  const hosts = subscribedHosts(config);
  const state = readGithubState(stateFile);
  const discovery = createRepoDiscovery({
    runner,
    now,
    refreshMs: options.repoRefreshMs ?? 10 * 60_000,
    maxRepos: options.maxReposPerOwner ?? 100,
    log,
  });

  const notificationHosts = hosts.filter((host) =>
    config.subscriptions.some(
      (subscription) =>
        subscription.host === host &&
        (!subscription.events?.length || subscription.events.some((name) => NOTIFICATION_EVENT_NAMES.has(name))),
    ),
  );

  const persist = (): void => {
    try {
      writeGithubState(state, stateFile);
    } catch (error) {
      log(`could not save the GitHub host state: ${(error as Error).message}`);
    }
  };

  const statusOf = (host: string): HostStatus => state.hosts[host] ?? { paused: false };
  const markSuccess = (host: string, nextPollMs: number): void => {
    const status = statusOf(host);
    status.lastSuccessAt = new Date(now()).toISOString();
    status.paused = false;
    status.lastError = undefined;
    status.nextPollAt = new Date(now() + nextPollMs).toISOString();
    state.hosts[host] = status;
  };
  const markFailure = (host: string, error: unknown): void => {
    const status = statusOf(host);
    status.lastError = { message: (error as Error).message, at: new Date(now()).toISOString() };
    state.hosts[host] = status;
  };

  const pollNotifications = async (
    cursor: string | null,
    _args: Record<string, unknown>,
    context: PollContext,
  ): Promise<EventPollResult> => {
    if (!notificationHosts.length) return { events: [], cursor, hasMore: false, nextPollMs: floorMs };

    const decoded = decodeCursor(cursor);
    const malformed = cursor !== null && decoded === undefined;
    const composite: CompositeCursor = decoded ?? { v: 1, hosts: {} };
    const collected = new Map<string, EventOccurrence<GithubEventData>>();
    const errors: NonNullable<EventPollResult["errors"]> = [];
    const intervals: number[] = [];
    let truncated = malformed;
    let more = false;

    for (const host of notificationHosts) {
      const status = statusOf(host);
      if (isPaused(status, now(), pausedRetryMs)) {
        intervals.push(pausedRetryMs);
        errors.push(pausedError(host));
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
        markSuccess(host, result.nextPollMs);
        if (baseline) continue;

        for (const notification of result.notifications) {
          const occurrence = mapNotification(host, notification);
          if (!occurrence) continue;
          if (!allowedByConfig(config, host, notification, occurrence.name as GithubEventName)) continue;
          collected.set(occurrence.eventId, occurrence);
        }
      } catch (error) {
        markFailure(host, error);
        const classified = classifyError(host, error, pausedRetryMs, floorMs);
        status.paused = classified.paused;
        intervals.push(classified.retryAfterMs);
        errors.push(classified.error);
      } finally {
        state.hosts[host] = status;
      }
    }

    persist();
    if (more) truncated = true;
    return finish(collected, errors, intervals, encodeCursor({ v: 1, hosts: composite.hosts }), truncated, context, floorMs);
  };

  const pollRepoEvents = async (
    cursor: string | null,
    _args: Record<string, unknown>,
    context: PollContext,
  ): Promise<EventPollResult> => {
    const decoded = decodeRepoCursor(cursor);
    const malformed = cursor !== null && decoded === undefined;
    const repoCursor: RepoCursor = decoded ?? { v: 1, repos: {} };
    const collected = new Map<string, EventOccurrence<CreatedData | CiData>>();
    const errors: NonNullable<EventPollResult["errors"]> = [];
    const intervals: number[] = [];
    let truncated = malformed;
    const pausedHosts = new Set<string>();
    for (const host of hosts) {
      if (isPaused(statusOf(host), now(), pausedRetryMs)) pausedHosts.add(host);
    }

    const discoveryAuthHosts = new Set<string>();
    const createdRefs = await wantedRepos(["github.issue.created", "github.pr.created"], config, discovery, context.signal, errors, discoveryAuthHosts);
    const ciRefs = await wantedRepos(["github.ci.failed"], config, discovery, context.signal, errors, discoveryAuthHosts);
    for (const host of discoveryAuthHosts) {
      const status = statusOf(host);
      status.paused = true;
      status.lastError = { message: "authentication failed while listing repositories", at: new Date(now()).toISOString() };
      state.hosts[host] = status;
      pausedHosts.add(host);
    }

    const handleCreated = async (ref: RepoRef): Promise<void> => {
      if (skipHost(ref.host, pausedHosts, errors, intervals, pausedRetryMs)) return;
      const key = repoKey(ref);
      const saved = repoCursor.repos[key]?.created;
      const baseline = !saved;
      const cursor: CreatedCursor = saved ?? {
        since: new Date(now() - overlapMs).toISOString(),
        createdAt: new Date(now()).toISOString(),
      };
      try {
        const result = await pollCreated({
          runner,
          host: ref.host,
          repo: ref.repo,
          floorMs,
          cursor,
          signal: context.signal,
          now,
          overlapMs,
          baseline,
        });
        repoCursor.repos[key] = { ...(repoCursor.repos[key] ?? {}), created: result.cursor };
        intervals.push(result.nextPollMs);
        if (result.hasMore) truncated = true;
        markSuccess(ref.host, result.nextPollMs);
        for (const event of result.events) {
          if (!matchesAnySubscription(config, ref.host, event.data.repo, event.name as GithubEventName)) continue;
          collected.set(event.eventId, event);
        }
      } catch (error) {
        markFailure(ref.host, error);
        const classified = classifyError(ref.host, error, pausedRetryMs, floorMs, ref.repo);
        if (classified.paused) {
          pausedHosts.add(ref.host);
          const status = statusOf(ref.host);
          status.paused = true;
          state.hosts[ref.host] = status;
        }
        intervals.push(classified.retryAfterMs);
        errors.push(classified.error);
      }
    };

    const handleCi = async (ref: RepoRef): Promise<void> => {
      if (skipHost(ref.host, pausedHosts, errors, intervals, pausedRetryMs)) return;
      const key = repoKey(ref);
      const saved = repoCursor.repos[key]?.ci;
      const baseline = !saved;
      const cursor: CiCursor = saved ?? { lastUpdatedAt: new Date(now()).toISOString() };
      try {
        const result = await pollCi({
          runner,
          host: ref.host,
          repo: ref.repo,
          floorMs,
          cursor,
          signal: context.signal,
          now,
          overlapMs,
          baseline,
        });
        repoCursor.repos[key] = { ...(repoCursor.repos[key] ?? {}), ci: result.cursor };
        intervals.push(result.nextPollMs);
        if (result.hasMore) truncated = true;
        markSuccess(ref.host, result.nextPollMs);
        for (const event of result.events) {
          if (!matchesAnySubscription(config, ref.host, event.data.repo, "github.ci.failed")) continue;
          collected.set(event.eventId, event);
        }
      } catch (error) {
        markFailure(ref.host, error);
        const classified = classifyError(ref.host, error, pausedRetryMs, floorMs, ref.repo);
        if (classified.paused) {
          pausedHosts.add(ref.host);
          const status = statusOf(ref.host);
          status.paused = true;
          state.hosts[ref.host] = status;
        }
        intervals.push(classified.retryAfterMs);
        errors.push(classified.error);
      }
    };

    for (const ref of createdRefs) await handleCreated(ref);
    for (const ref of ciRefs) await handleCi(ref);

    persist();
    return finish(collected, errors, intervals, encodeRepoCursor(repoCursor), truncated, context, floorMs);
  };

  const notificationEvents = EVENT_TYPES.map((event) =>
    defineEvent<Record<string, unknown>, GithubEventData>({
      name: event.name,
      description: event.description,
      group: GITHUB_GROUP,
      shared: true,
      inputSchema: INPUT_SCHEMA,
      payloadSchema: PAYLOAD_SCHEMA,
      filter: (occurrence, args) => eventMatchesArguments(occurrence.data, args),
      poll: pollNotifications,
    }),
  ) as EventDefinition<any, any>[];

  const repoEvents = REPO_EVENT_TYPES.map((event) =>
    defineEvent<Record<string, unknown>, CreatedData | CiData>({
      name: event.name,
      description: event.description,
      group: GITHUB_REPO_GROUP,
      shared: true,
      inputSchema: event.name === "github.ci.failed" ? CI_INPUT_SCHEMA : CREATED_INPUT_SCHEMA,
      payloadSchema: event.name === "github.ci.failed" ? CI_PAYLOAD_SCHEMA : CREATED_PAYLOAD_SCHEMA,
      filter: (occurrence, args) =>
        event.name === "github.ci.failed"
          ? ciMatches(occurrence.data as CiData, args)
          : createdMatches(occurrence.data as CreatedData, args),
      poll: pollRepoEvents,
    }),
  ) as EventDefinition<any, any>[];

  return {
    events: [...notificationEvents, ...repoEvents],
    status: () => summarize(hosts, state, now, pausedRetryMs),
    health: () => ({ github: summarize(hosts, state, now, pausedRetryMs) }),
    close: () => discovery.clear(),
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
      "A workflow run you triggered or watched completed. GitHub does not say pass/fail in the notification; see docs/notifications.md. Prefer github.ci.failed.",
  },
  { name: "github.issue.assigned", description: "An issue was assigned to you." },
  { name: "github.issue.comment", description: "An issue you participate in or watch got a comment." },
  { name: "github.mention", description: "You or a team you are on were mentioned." },
];

const REPO_EVENT_TYPES: EventTypeDescription[] = [
  { name: "github.issue.created", description: "A new issue was created in a subscribed repository." },
  { name: "github.pr.created", description: "A new pull request was created in a subscribed repository." },
  {
    name: "github.ci.failed",
    description: "A completed workflow run with a failure-like conclusion. Includes the branch and workflow.",
  },
];

function repoKey(ref: RepoRef): string {
  return `${ref.host}/${ref.repo.toLowerCase()}`;
}

async function wantedRepos(
  eventNames: GithubEventName[],
  config: Config,
  discovery: ReturnType<typeof createRepoDiscovery>,
  signal: AbortSignal | undefined,
  errors: NonNullable<EventPollResult["errors"]>,
  authHosts: Set<string>,
): Promise<RepoRef[]> {
  const refs = new Map<string, RepoRef>();
  for (const eventName of eventNames) {
    try {
      for (const ref of await reposForEvent(config, discovery, eventName, signal)) refs.set(repoKey(ref), ref);
    } catch (error) {
      if (isAuthError(error)) {
        const host = (error as { host?: string }).host;
        if (host) authHosts.add(host);
        errors.push({
          code: -32024,
          message: "Forbidden",
          data: { ...(host ? { host } : {}), reason: "authentication failed while listing repositories; run gh auth login" },
        });
      } else {
        errors.push({
          code: -32603,
          message: "UpstreamError",
          data: { host: (error as { host?: string }).host, reason: (error as Error).message },
        });
      }
    }
  }
  return [...refs.values()];
}

function skipHost(
  host: string,
  pausedHosts: Set<string>,
  errors: NonNullable<EventPollResult["errors"]>,
  intervals: number[],
  pausedRetryMs: number,
): boolean {
  if (!pausedHosts.has(host)) return false;
  if (!errors.some((error) => error.code === -32024 && error.data?.host === host)) errors.push(pausedError(host));
  intervals.push(pausedRetryMs);
  return true;
}

function pausedError(host: string): NonNullable<EventPollResult["errors"]>[number] {
  return {
    code: -32024,
    message: "Forbidden",
    data: { host, reason: "host paused after an authentication failure; run gh auth login --hostname " + host },
  };
}

function classifyError(
  host: string,
  error: unknown,
  pausedRetryMs: number,
  floorMs: number,
  repo?: string,
): { paused: boolean; retryAfterMs: number; error: NonNullable<EventPollResult["errors"]>[number] } {
  if (isAuthError(error)) {
    return {
      paused: true,
      retryAfterMs: pausedRetryMs,
      error: {
        code: -32024,
        message: "Forbidden",
        data: { host, ...(repo ? { repo } : {}), reason: "authentication failed; run gh auth login --hostname " + host },
      },
    };
  }
  if (isRateLimit(error)) {
    const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs ?? 60_000;
    return {
      paused: false,
      retryAfterMs,
      error: { code: -32603, message: "UpstreamRateLimited", data: { host, ...(repo ? { repo } : {}), retryAfterMs } },
    };
  }
  return {
    paused: false,
    retryAfterMs: floorMs,
    error: {
      code: -32603,
      message: "UpstreamError",
      data: { host, ...(repo ? { repo } : {}), reason: (error as Error).message },
    },
  };
}

function finish(
  collected: Map<string, EventOccurrence<any>>,
  errors: NonNullable<EventPollResult["errors"]>,
  intervals: number[],
  cursor: string,
  truncated: boolean,
  context: PollContext,
  floorMs: number,
): EventPollResult {
  const events = [...collected.values()].sort((a, b) =>
    a.timestamp === b.timestamp ? a.eventId.localeCompare(b.eventId) : a.timestamp.localeCompare(b.timestamp),
  );
  let limited = events;
  let gap = truncated;
  if (limited.length > context.maxEvents) {
    limited = limited.slice(0, context.maxEvents);
    gap = true;
  }
  const nextPollMs = Math.max(floorMs, intervals.length ? Math.min(...intervals) : floorMs);
  return {
    events: limited,
    cursor,
    hasMore: false,
    nextPollMs,
    truncated: gap,
    ...(errors.length ? { errors } : {}),
  };
}

function summarize(
  hosts: string[],
  state: GithubState,
  now: () => number,
  pausedRetryMs: number,
): { hosts: number; paused: number; lastPollAt?: string } {
  const statuses = hosts.map((host) => state.hosts[host]).filter((status): status is HostStatus => !!status);
  const paused = statuses.filter((status) => isPaused(status, now(), pausedRetryMs)).length;
  const times = statuses.map((status) => status.lastSuccessAt).filter((value): value is string => !!value).sort();
  return { hosts: hosts.length, paused, lastPollAt: times[times.length - 1] };
}

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
