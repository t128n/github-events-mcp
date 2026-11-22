import { matchesAnySubscription, type Config, type GithubEventName } from "../config/config.ts";
import type { EventOccurrence } from "@github-events-mcp/events";
import {
  GhAuthError,
  GhHttpError,
  GhRateLimitError,
  header,
  headerNumber,
  retryAfterMs,
  type GhResponse,
  type GhRunner,
} from "./runner.ts";

export interface Subject {
  title?: string;
  type?: string;
  url?: string;
  latest_comment_url?: string;
}

export interface Notification {
  id: string;
  reason: string;
  updated_at: string;
  repository: { full_name: string; html_url?: string };
  subject: Subject;
}

export interface HostCursor {
  /** ISO timestamp passed as `since`, plus the last validators from GitHub. */
  since: string;
  etag?: string;
  lastModified?: string;
  nextPollMs?: number;
}

export interface CompositeCursor {
  v: 1;
  hosts: Record<string, HostCursor>;
}

export interface HostPollResult {
  cursor: HostCursor;
  notifications: Notification[];
  nextPollMs: number;
  /** GitHub has another page; the poller reports a gap rather than looping forever. */
  hasMore: boolean;
}

export const encodeCursor = (cursor: CompositeCursor): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

export function decodeCursor(value: string | null): CompositeCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as CompositeCursor;
    if (parsed?.v !== 1 || typeof parsed.hosts !== "object" || parsed.hosts === null) return undefined;
    for (const host of Object.values(parsed.hosts)) {
      if (!host || typeof host.since !== "string") return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export interface PollHostOptions {
  runner: GhRunner;
  host: string;
  cursor: HostCursor;
  floorMs: number;
  participatingOnly: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * One conditional `GET /notifications` for one host. A 304 is a success with no notifications.
 * `since` is the last updated_at we saw, so a restart neither replays nor skips.
 */
export async function pollHost(options: PollHostOptions): Promise<HostPollResult> {
  const now = options.now ?? Date.now;
  const query = new URLSearchParams({
    all: options.participatingOnly ? "false" : "true",
    since: options.cursor.since,
    per_page: "50",
  });
  const args = [
    "api",
    "-i",
    "--hostname",
    options.host,
    `/notifications?${query.toString()}`,
    "-H",
    "Accept: application/vnd.github+json",
  ];
  if (options.cursor.etag) args.push("-H", `If-None-Match: ${options.cursor.etag}`);
  if (options.cursor.lastModified) args.push("-H", `If-Modified-Since: ${options.cursor.lastModified}`);

  const response = await options.runner.run(args, { signal: options.signal, timeoutMs: options.timeoutMs ?? 30_000 });
  const nextPollMs = pollInterval(response, options.floorMs, options.cursor.nextPollMs);

  if (response.status === 304) {
    return {
      cursor: {
        ...options.cursor,
        ...(header(response, "etag") ? { etag: header(response, "etag")! } : {}),
        ...(header(response, "last-modified") ? { lastModified: header(response, "last-modified")! } : {}),
        nextPollMs,
      },
      notifications: [],
      nextPollMs,
      hasMore: false,
    };
  }

  if (response.status === 401) throw new GhAuthError(options.host, "HTTP 401");
  if (response.status === 403 || response.status === 429) {
    const limited =
      response.status === 429 ||
      headerNumber(response, "x-ratelimit-remaining") === 0 ||
      /rate limit|abuse/i.test(response.body) ||
      !!header(response, "retry-after");
    if (limited) {
      throw new GhRateLimitError(options.host, retryAfterMs(response, now()) ?? 60_000, `HTTP ${response.status}`);
    }
    throw new GhAuthError(options.host, `HTTP ${response.status}; the token needs the notifications or repo scope`);
  }
  if (response.status !== 200) throw new GhHttpError(options.host, response.status, response.stderr.trim());

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new GhHttpError(options.host, response.status, "the response body is not JSON");
  }
  if (!Array.isArray(parsed)) throw new GhHttpError(options.host, response.status, "the response body is not an array");

  const notifications: Notification[] = [];
  let since = options.cursor.since;
  for (const item of parsed) {
    const notification = asNotification(item);
    if (!notification) continue;
    notifications.push(notification);
    if (Date.parse(notification.updated_at) > Date.parse(since)) since = notification.updated_at;
  }

  return {
    cursor: {
      since,
      ...(header(response, "etag") ? { etag: header(response, "etag")! } : {}),
      ...(header(response, "last-modified") ? { lastModified: header(response, "last-modified")! } : {}),
      nextPollMs,
    },
    notifications,
    nextPollMs,
    hasMore: /rel="next"/.test(header(response, "link") ?? ""),
  };
}

/** The event table from #5. The first match wins. */
export function eventNameFor(notification: Notification): GithubEventName | null {
  const reason = notification.reason.toLowerCase();
  const type = notification.subject.type;
  if (reason === "mention" || reason === "team_mention") return "github.mention";
  if (reason === "ci_activity") return "github.pr.ci_failed";
  if (reason === "review_requested" && type === "PullRequest") return "github.pr.review_requested";
  if (type === "PullRequest" && ["comment", "author", "subscribed"].includes(reason)) return "github.pr.comment";
  if (type === "Issue" && reason === "assign") return "github.issue.assigned";
  if (type === "Issue" && ["comment", "author", "subscribed"].includes(reason)) return "github.issue.comment";
  return null;
}

export interface GithubEventData {
  host: string;
  repo: string;
  reason: string;
  subjectType: string;
  title: string;
  url: string;
  updatedAt: string;
  threadId: string;
}

/** Thin payload: no body, no comment text, no notification subject content beyond the title. */
export function mapNotification(host: string, notification: Notification): EventOccurrence<GithubEventData> | null {
  const name = eventNameFor(notification);
  if (!name) return null;
  const title = typeof notification.subject.title === "string" ? notification.subject.title.slice(0, 500) : "";
  return {
    eventId: `${host}:${notification.id}:${notification.updated_at}`,
    name,
    timestamp: notification.updated_at,
    data: {
      host,
      repo: notification.repository.full_name,
      reason: notification.reason,
      subjectType: notification.subject.type ?? "",
      title,
      url: webUrl(host, notification),
      updatedAt: notification.updated_at,
      threadId: String(notification.id),
    },
  };
}

/** `owner/repo` or `owner/*`, applied to the MCP subscription arguments. */
export function eventMatchesArguments(data: GithubEventData, args: Record<string, unknown>): boolean {
  const repos = Array.isArray(args.repos) ? args.repos.filter((item): item is string => typeof item === "string") : [];
  if (repos.length && !repos.some((pattern) => repoMatches(pattern, data.repo))) return false;
  const reasons = Array.isArray(args.reasons) ? args.reasons.filter((item): item is string => typeof item === "string") : [];
  if (reasons.length && !reasons.includes(data.reason)) return false;
  return true;
}

export function repoMatches(pattern: string, repositoryFullName: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  const full = repositoryFullName.toLowerCase();
  if (normalized.endsWith("/*")) return full.startsWith(`${normalized.slice(0, -1)}`);
  return normalized === full;
}

export function allowedByConfig(config: Config, host: string, notification: Notification, name: GithubEventName): boolean {
  return matchesAnySubscription(config, host, notification.repository.full_name, name);
}

/** The web URL a person would open, derived from the API URL in the notification. */
export function webUrl(host: string, notification: Notification): string {
  const fallback = notification.repository.html_url ?? `https://${host}/${notification.repository.full_name}`;
  const api = notification.subject.url ?? notification.subject.latest_comment_url;
  if (!api) return fallback;
  let path: string;
  try {
    path = new URL(api).pathname;
  } catch {
    return fallback;
  }
  const match = /^(?:\/api\/v3)?\/repos\/[^/]+\/[^/]+\/(.+)$/.exec(path);
  if (!match) return fallback;
  const rest = match[1]!;
  const routes: Array<[RegExp, string]> = [
    [/^pulls\/(\d+)/, "pull"],
    [/^issues\/(\d+)/, "issues"],
    [/^commits\/([^/]+)/, "commit"],
    [/^discussions\/(\d+)/, "discussions"],
    [/^releases\/(\d+)/, "releases"],
  ];
  for (const [pattern, segment] of routes) {
    const found = pattern.exec(rest);
    if (found) return `${fallback}/${segment}/${found[1]}`;
  }
  return fallback;
}

export function pollInterval(response: GhResponse, floorMs: number, previous?: number): number {
  const seconds = headerNumber(response, "x-poll-interval");
  const fromServer = seconds === undefined ? previous : seconds * 1000;
  return Math.max(floorMs, fromServer ?? floorMs);
}

function asNotification(value: unknown): Notification | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, any>;
  if (item.id === undefined || typeof item.reason !== "string" || typeof item.updated_at !== "string") return null;
  const repository = item.repository;
  const subject = item.subject;
  if (typeof repository !== "object" || repository === null || typeof repository.full_name !== "string") return null;
  if (typeof subject !== "object" || subject === null) return null;
  return {
    id: String(item.id),
    reason: item.reason,
    updated_at: item.updated_at,
    repository: {
      full_name: repository.full_name,
      ...(typeof repository.html_url === "string" ? { html_url: repository.html_url } : {}),
    },
    subject: {
      ...(typeof subject.title === "string" ? { title: subject.title } : {}),
      ...(typeof subject.type === "string" ? { type: subject.type } : {}),
      ...(typeof subject.url === "string" ? { url: subject.url } : {}),
      ...(typeof subject.latest_comment_url === "string" ? { latest_comment_url: subject.latest_comment_url } : {}),
    },
  };
}
