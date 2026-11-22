import type { EventOccurrence } from "@github-events-mcp/events";
import { matchesAnySubscription, type Config, type GithubEventName } from "../config/config.ts";
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
import { repoMatches } from "./notifications.ts";

/** Failure-like Actions conclusions. A cancelled or neutral run is not a failure. */
export const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

export interface CreatedData {
  host: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  subjectType: "Issue" | "PullRequest";
  createdAt: string;
  updatedAt: string;
}

export interface CiData {
  host: string;
  repo: string;
  branch: string;
  workflow: string;
  conclusion: string;
  event: string;
  runId: string;
  attempt: number;
  url: string;
  updatedAt: string;
}

export interface CreatedCursor {
  /** `since` for the issues API, with a small overlap so a same-second item is not missed. */
  since: string;
  /** Newest created_at that has been handled. */
  createdAt: string;
  etag?: string;
  lastModified?: string;
  seen?: string[];
}

export interface CiCursor {
  /** Newest updated_at that has been handled. */
  lastUpdatedAt: string;
  etag?: string;
  lastModified?: string;
  seen?: string[];
}

export interface RepoState {
  created?: CreatedCursor;
  ci?: CiCursor;
}

export interface RepoCursor {
  v: 1;
  repos: Record<string, RepoState>;
}

export const encodeRepoCursor = (cursor: RepoCursor): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

export function decodeRepoCursor(value: string | null): RepoCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as RepoCursor;
    if (parsed?.v !== 1 || typeof parsed.repos !== "object" || parsed.repos === null) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export interface RepoDiscoveryOptions {
  runner: GhRunner;
  now?: () => number;
  refreshMs?: number;
  maxRepos?: number;
  log?: (message: string) => void;
}

export interface RepoDiscovery {
  repos(host: string, owner: string, signal?: AbortSignal): Promise<string[]>;
  clear(): void;
}

/** Resolves `owner/*` to concrete repositories and caches the result for a while. */
export function createRepoDiscovery(options: RepoDiscoveryOptions): RepoDiscovery {
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? 10 * 60_000;
  const maxRepos = options.maxRepos ?? 100;
  const log = options.log ?? (() => {});
  const cache = new Map<string, { at: number; repos: string[] }>();

  return {
    async repos(host, owner, signal) {
      const key = `${host}/${owner.toLowerCase()}`;
      const cached = cache.get(key);
      if (cached && now() - cached.at < refreshMs) return cached.repos;

      const attempts = [
        `/orgs/${encodeURIComponent(owner)}/repos?type=all&per_page=100&sort=pushed&direction=desc`,
        `/users/${encodeURIComponent(owner)}/repos?type=owner&per_page=100&sort=pushed&direction=desc`,
      ];
      let lastError: unknown;
      for (const path of attempts) {
        const response = await options.runner.run(["api", "-i", "--hostname", host, path, "-H", "Accept: application/vnd.github+json"], {
          signal,
          timeoutMs: 30_000,
        });
        if (response.status === 404) {
          lastError = new GhHttpError(host, 404, "owner not found");
          continue;
        }
        throwForStatus(response, host, now());
        if (response.status === 304) return cached?.repos ?? [];
        let parsed: unknown;
        try {
          parsed = JSON.parse(response.body);
        } catch {
          throw new GhHttpError(host, response.status, "the repository list is not JSON");
        }
        if (!Array.isArray(parsed)) throw new GhHttpError(host, response.status, "the repository list is not an array");
        const repos: string[] = [];
        for (const item of parsed) {
          const fullName = (item as { full_name?: unknown })?.full_name;
          if (typeof fullName !== "string") continue;
          if ((item as { archived?: unknown }).archived === true) continue;
          if ((item as { disabled?: unknown }).disabled === true) continue;
          repos.push(fullName);
          if (repos.length >= maxRepos) break;
        }
        if (repos.length >= maxRepos) log(`repository discovery for ${owner} reached the ${maxRepos}-repository cap`);
        cache.set(key, { at: now(), repos });
        return repos;
      }
      if (cached) {
        log(`repository discovery for ${owner} failed; using the cached list`);
        return cached.repos;
      }
      throw lastError instanceof Error ? lastError : new Error(`could not list repositories for ${owner}`);
    },
    clear() {
      cache.clear();
    },
  };
}

export interface RepoPollOptions {
  runner: GhRunner;
  host: string;
  repo: string;
  floorMs: number;
  signal?: AbortSignal;
  now?: () => number;
  overlapMs?: number;
  baseline?: boolean;
}

export interface CreatedPollResult {
  cursor: CreatedCursor;
  events: EventOccurrence<CreatedData>[];
  nextPollMs: number;
  hasMore: boolean;
}

/** Polls issues and pull requests created in one repository. */
export async function pollCreated(options: RepoPollOptions & { cursor: CreatedCursor }): Promise<CreatedPollResult> {
  const now = options.now ?? Date.now;
  const overlapMs = options.overlapMs ?? 10 * 60_000;
  const query = new URLSearchParams({
    state: "all",
    sort: "created",
    direction: "desc",
    per_page: "100",
    since: options.cursor.since,
  });
  const args = [
    "api",
    "-i",
    "--hostname",
    options.host,
    `/repos/${options.repo}/issues?${query.toString()}`,
    "-H",
    "Accept: application/vnd.github+json",
  ];
  if (options.cursor.etag) args.push("-H", `If-None-Match: ${options.cursor.etag}`);
  if (options.cursor.lastModified) args.push("-H", `If-Modified-Since: ${options.cursor.lastModified}`);

  const response = await options.runner.run(args, { signal: options.signal, timeoutMs: 30_000 });
  if (response.status === 304) {
    return { cursor: withValidators(options.cursor, response), events: [], nextPollMs: options.floorMs, hasMore: false };
  }
  throwForStatus(response, options.host, now());

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new GhHttpError(options.host, response.status, "the issue list is not JSON");
  }
  if (!Array.isArray(parsed)) throw new GhHttpError(options.host, response.status, "the issue list is not an array");

  const seen = new Set(options.cursor.seen ?? []);
  const events: EventOccurrence<CreatedData>[] = [];
  let newest = options.cursor.createdAt;
  for (const item of parsed) {
    const issue = asIssue(item);
    if (!issue) continue;
    if (issue.createdAt > newest) newest = issue.createdAt;
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    if (options.baseline) continue;
    if (issue.createdAt < options.cursor.createdAt) continue;
    events.push(createdOccurrence(options.host, options.repo, issue));
  }

  const cursor: CreatedCursor = {
    since: new Date(now() - overlapMs).toISOString(),
    createdAt: options.baseline ? new Date(now()).toISOString() : newest,
    seen: [...seen].slice(-500),
  };
  return {
    cursor,
    events,
    nextPollMs: options.floorMs,
    hasMore: /rel="next"/.test(header(response, "link") ?? ""),
  };
}

export interface CiPollResult {
  cursor: CiCursor;
  events: EventOccurrence<CiData>[];
  nextPollMs: number;
  hasMore: boolean;
}

/** Polls completed workflow runs in one repository and keeps the failure-like ones. */
export async function pollCi(options: RepoPollOptions & { cursor: CiCursor }): Promise<CiPollResult> {
  const now = options.now ?? Date.now;
  const overlapMs = options.overlapMs ?? 10 * 60_000;
  const args = [
    "api",
    "-i",
    "--hostname",
    options.host,
    `/repos/${options.repo}/actions/runs?status=completed&per_page=100&sort=updated&direction=desc`,
    "-H",
    "Accept: application/vnd.github+json",
  ];
  if (options.cursor.etag) args.push("-H", `If-None-Match: ${options.cursor.etag}`);
  if (options.cursor.lastModified) args.push("-H", `If-Modified-Since: ${options.cursor.lastModified}`);

  const response = await options.runner.run(args, { signal: options.signal, timeoutMs: 30_000 });
  if (response.status === 304) {
    return { cursor: withValidators(options.cursor, response), events: [], nextPollMs: options.floorMs, hasMore: false };
  }
  throwForStatus(response, options.host, now());

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body) as { workflow_runs?: unknown };
  } catch {
    throw new GhHttpError(options.host, response.status, "the run list is not JSON");
  }
  const runs = (parsed as { workflow_runs?: unknown })?.workflow_runs;
  if (!Array.isArray(runs)) throw new GhHttpError(options.host, response.status, "the run list has no workflow_runs array");

  const seen = new Set(options.cursor.seen ?? []);
  const events: EventOccurrence<CiData>[] = [];
  let newest = options.cursor.lastUpdatedAt;
  const threshold = Date.parse(options.cursor.lastUpdatedAt) - overlapMs;
  for (const item of runs) {
    const run = asRun(item);
    if (!run) continue;
    if (run.updatedAt > newest) newest = run.updatedAt;
    if (seen.has(run.key)) continue;
    seen.add(run.key);
    if (options.baseline) continue;
    if (Date.parse(run.updatedAt) < threshold) continue;
    if (!FAILURE_CONCLUSIONS.has(run.conclusion)) continue;
    events.push(ciOccurrence(options.host, options.repo, run));
  }

  const cursor: CiCursor = {
    lastUpdatedAt: options.baseline ? new Date(now()).toISOString() : newest,
    seen: [...seen].slice(-500),
    ...validators(response),
  };
  return {
    cursor,
    events,
    nextPollMs: options.floorMs,
    hasMore: /rel="next"/.test(header(response, "link") ?? ""),
  };
}

export function createdMatches(data: CreatedData, args: Record<string, unknown>): boolean {
  if (!repoArgumentMatches(data.repo, args)) return false;
  const authors = stringArray(args.authors);
  if (authors.length && !authors.some((pattern) => simpleGlob(pattern, data.author, false))) return false;
  return true;
}

export function ciMatches(data: CiData, args: Record<string, unknown>): boolean {
  if (!repoArgumentMatches(data.repo, args)) return false;
  const branches = stringArray(args.branches);
  if (branches.length && !branches.some((pattern) => simpleGlob(pattern, data.branch, true))) return false;
  const workflows = stringArray(args.workflows);
  if (workflows.length && !workflows.some((pattern) => simpleGlob(pattern, data.workflow, true))) return false;
  const conclusions = stringArray(args.conclusions);
  if (conclusions.length && !conclusions.includes(data.conclusion)) return false;
  return true;
}

export interface RepoRef {
  host: string;
  repo: string;
}

/** Repositories that at least one subscription allows for this event type. */
export async function reposForEvent(
  config: Config,
  discovery: RepoDiscovery,
  eventName: GithubEventName,
  signal?: AbortSignal,
): Promise<RepoRef[]> {
  const repos = new Map<string, RepoRef>();
  for (const subscription of config.subscriptions) {
    if (subscription.events?.length && !subscription.events.includes(eventName)) continue;
    const [owner, repo] = subscription.repo.split("/");
    if (!owner || !repo) continue;
    if (repo !== "*") {
      const full = `${owner}/${repo}`;
      if (matchesAnySubscription(config, subscription.host, full, eventName)) {
        repos.set(`${subscription.host}/${full.toLowerCase()}`, { host: subscription.host, repo: full });
      }
      continue;
    }
    const found = await discovery.repos(subscription.host, owner, signal);
    for (const full of found) {
      if (matchesAnySubscription(config, subscription.host, full, eventName)) {
        repos.set(`${subscription.host}/${full.toLowerCase()}`, { host: subscription.host, repo: full });
      }
    }
  }
  return [...repos.values()].sort((a, b) => `${a.host}/${a.repo}`.localeCompare(`${b.host}/${b.repo}`));
}

function asIssue(value: unknown): { id: string; number: number; createdAt: string; title: string; url: string; author: string; updatedAt: string; isPr: boolean } | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, any>;
  if (item.id === undefined || typeof item.created_at !== "string" || typeof item.number !== "number") return null;
  if (typeof item.html_url !== "string") return null;
  return {
    id: String(item.id),
    number: item.number,
    createdAt: item.created_at,
    title: typeof item.title === "string" ? item.title.slice(0, 500) : "",
    url: item.html_url,
    author: typeof item.user?.login === "string" ? item.user.login : "",
    updatedAt: typeof item.updated_at === "string" ? item.updated_at : item.created_at,
    isPr: !!item.pull_request,
  };
}

function createdOccurrence(host: string, repo: string, issue: ReturnType<typeof asIssue> & {}): EventOccurrence<CreatedData> {
  return {
    eventId: `${host}:${repo}:${issue.isPr ? "pr" : "issue"}:${issue.number}:${issue.createdAt}`,
    name: issue.isPr ? "github.pr.created" : "github.issue.created",
    timestamp: issue.createdAt,
    data: {
      host,
      repo,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      author: issue.author,
      subjectType: issue.isPr ? "PullRequest" : "Issue",
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    },
  };
}

function asRun(value: unknown): { key: string; id: string; attempt: number; conclusion: string; branch: string; workflow: string; event: string; url: string; updatedAt: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, any>;
  if (item.id === undefined || typeof item.conclusion !== "string") return null;
  if (typeof item.updated_at !== "string") return null;
  const attempt = Number(item.run_attempt ?? 1);
  return {
    key: `${item.id}:${attempt}`,
    id: String(item.id),
    attempt: Number.isFinite(attempt) ? attempt : 1,
    conclusion: item.conclusion,
    branch: typeof item.head_branch === "string" ? item.head_branch : "",
    workflow: typeof item.name === "string" ? item.name : "",
    event: typeof item.event === "string" ? item.event : "",
    url: typeof item.html_url === "string" ? item.html_url : "",
    updatedAt: item.updated_at,
  };
}

function ciOccurrence(host: string, repo: string, run: ReturnType<typeof asRun> & {}): EventOccurrence<CiData> {
  return {
    eventId: `${host}:${repo}:run:${run.id}:${run.attempt}`,
    name: "github.ci.failed",
    timestamp: run.updatedAt,
    data: {
      host,
      repo,
      branch: run.branch,
      workflow: run.workflow,
      conclusion: run.conclusion,
      event: run.event,
      runId: run.id,
      attempt: run.attempt,
      url: run.url,
      updatedAt: run.updatedAt,
    },
  };
}

function throwForStatus(response: GhResponse, host: string, now: number): void {
  if (response.status === 200) return;
  if (response.status === 401) throw new GhAuthError(host, "HTTP 401");
  if (response.status === 403 || response.status === 429) {
    const limited =
      response.status === 429 ||
      headerNumber(response, "x-ratelimit-remaining") === 0 ||
      /rate limit|abuse/i.test(response.body) ||
      !!header(response, "retry-after");
    if (limited) throw new GhRateLimitError(host, retryAfterMs(response, now) ?? 60_000, `HTTP ${response.status}`);
    throw new GhAuthError(host, `HTTP ${response.status}; the token needs the repo scope`);
  }
  throw new GhHttpError(host, response.status, response.stderr.trim());
}

function withValidators<T extends { etag?: string; lastModified?: string }>(cursor: T, response: GhResponse): T {
  return { ...cursor, ...validators(response) };
}

function validators(response: GhResponse): { etag?: string; lastModified?: string } {
  return {
    ...(header(response, "etag") ? { etag: header(response, "etag")! } : {}),
    ...(header(response, "last-modified") ? { lastModified: header(response, "last-modified")! } : {}),
  };
}

function repoArgumentMatches(repo: string, args: Record<string, unknown>): boolean {
  const repos = stringArray(args.repos);
  return !repos.length || repos.some((pattern) => repoMatches(pattern, repo));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** `*` and `?` globs; repositories are case-insensitive, branch and workflow names are not. */
export function simpleGlob(pattern: string, value: string, caseSensitive: boolean): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`, caseSensitive ? "" : "i").test(value);
}
