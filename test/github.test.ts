import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventHub, MemoryStateStore } from "@github-events-mcp/events";
import { defaultConfig, type Config } from "../src/config/config.ts";
import {
  decodeCursor,
  encodeCursor,
  eventMatchesArguments,
  eventNameFor,
  mapNotification,
  pollHost,
  type Notification,
} from "../src/github/notifications.ts";
import { GhAuthError, GhRateLimitError, type GhResponse, type GhRunner } from "../src/github/runner.ts";
import { createGithubSource } from "../src/github/source.ts";
import { readGithubState } from "../src/github/state.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "github-events-github-"));
  dirs.push(dir);
  return dir;
}

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "1001",
    reason: "review_requested",
    updated_at: "2026-01-02T03:04:05Z",
    repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
    subject: { title: "A pull request", type: "PullRequest", url: "https://api.github.com/repos/owner/repo/pulls/7" },
    ...overrides,
    ...(overrides.repository ? { repository: { ...overrides.repository } } : {}),
    ...(overrides.subject ? { subject: { ...overrides.subject } } : {}),
  };
}

function response(status: number, body: unknown = [], headers: Record<string, string> = {}): GhResponse {
  return { status, headers, body: typeof body === "string" ? body : JSON.stringify(body), stderr: status >= 400 ? `gh: HTTP ${status}` : "", exitCode: status >= 400 ? 1 : 0 };
}

class FakeGh implements GhRunner {
  calls: string[][] = [];
  constructor(private readonly handler: (args: string[]) => GhResponse | Promise<GhResponse>) {}
  async run(args: string[]): Promise<GhResponse> {
    this.calls.push(args);
    return this.handler(args);
  }
}

const hostOf = (args: string[]): string => args[args.indexOf("--hostname") + 1] ?? "";

describe("notification mapping", () => {
  test("maps the six event types and ignores the rest", () => {
    expect(eventNameFor(notification())).toBe("github.pr.review_requested");
    expect(eventNameFor(notification({ reason: "comment" }))).toBe("github.pr.comment");
    expect(eventNameFor(notification({ reason: "author", subject: { type: "Issue", title: "i" } }))).toBe("github.issue.comment");
    expect(eventNameFor(notification({ reason: "assign", subject: { type: "Issue", title: "i" } }))).toBe("github.issue.assigned");
    expect(eventNameFor(notification({ reason: "mention", subject: { type: "Issue", title: "i" } }))).toBe("github.mention");
    expect(eventNameFor(notification({ reason: "team_mention", subject: { type: "Discussion", title: "d" } }))).toBe("github.mention");
    // GitHub's notification does not say pass/fail; the issue maps ci_activity to this name.
    expect(eventNameFor(notification({ reason: "ci_activity", subject: { type: "CheckSuite", title: "CI" } }))).toBe("github.pr.ci_failed");
    expect(eventNameFor(notification({ reason: "manual", subject: { type: "Issue", title: "i" } }))).toBeNull();
    expect(eventNameFor(notification({ reason: "state_change", subject: { type: "PullRequest", title: "p" } }))).toBeNull();
  });

  test("builds a thin payload with a stable id and a web URL", () => {
    const event = mapNotification("github.com", notification())!;
    expect(event.eventId).toBe("github.com:1001:2026-01-02T03:04:05Z");
    expect(event.data.url).toBe("https://github.com/owner/repo/pull/7");
    expect(event.data.repo).toBe("owner/repo");
    expect(event.data.title).toBe("A pull request");
    expect(Object.keys(event.data).sort()).toEqual(["host", "reason", "repo", "subjectType", "threadId", "title", "updatedAt", "url"]);
    expect(JSON.stringify(event.data)).not.toContain("body");
  });

  test("uses the repository html_url for a GitHub Enterprise host", () => {
    const event = mapNotification(
      "github.example.com",
      notification({
        reason: "comment",
        repository: { full_name: "owner/repo", html_url: "https://github.example.com/owner/repo" },
        subject: { type: "Issue", title: "i", url: "https://github.example.com/api/v3/repos/owner/repo/issues/9" },
      }),
    )!;
    expect(event.data.url).toBe("https://github.example.com/owner/repo/issues/9");
  });

  test("caps the title", () => {
    const event = mapNotification("github.com", notification({ reason: "comment", subject: { type: "Issue", title: "x".repeat(900) } }))!;
    expect(event.data.title.length).toBe(500);
  });

  test("filters by repos and reasons arguments", () => {
    const event = mapNotification("github.com", notification())!;
    expect(eventMatchesArguments(event.data, {})).toBe(true);
    expect(eventMatchesArguments(event.data, { repos: ["owner/*"] })).toBe(true);
    expect(eventMatchesArguments(event.data, { repos: ["owner/repo"] })).toBe(true);
    expect(eventMatchesArguments(event.data, { repos: ["other/*"] })).toBe(false);
    expect(eventMatchesArguments(event.data, { reasons: ["review_requested"] })).toBe(true);
    expect(eventMatchesArguments(event.data, { reasons: ["comment"] })).toBe(false);
  });
});

describe("cursor", () => {
  test("round-trips and rejects garbage", () => {
    const cursor = { v: 1 as const, hosts: { "github.com": { since: "2026-01-01T00:00:00Z", etag: "W/\"abc\"" } } };
    const encoded = encodeCursor(cursor);
    expect(encoded).not.toContain("github.com");
    expect(decodeCursor(encoded)).toEqual(cursor);
    expect(decodeCursor("not a cursor")).toBeUndefined();
    expect(decodeCursor(Buffer.from(JSON.stringify({ v: 2, hosts: {} })).toString("base64url"))).toBeUndefined();
  });
});

describe("pollHost", () => {
  test("200 returns notifications and stores validators", async () => {
    const runner = new FakeGh(() =>
      response(200, [notification()], {
        etag: 'W/"abc"',
        "last-modified": "Thu, 01 Jan 2026 00:00:00 GMT",
        "x-poll-interval": "60",
      }),
    );
    const result = await pollHost({
      runner,
      host: "github.com",
      cursor: { since: "2026-01-01T00:00:00Z" },
      floorMs: 60_000,
      participatingOnly: true,
    });
    expect(result.notifications).toHaveLength(1);
    expect(result.cursor.etag).toBe('W/"abc"');
    expect(result.cursor.lastModified).toBe("Thu, 01 Jan 2026 00:00:00 GMT");
    expect(result.cursor.since).toBe("2026-01-02T03:04:05Z");
    expect(result.nextPollMs).toBe(60_000);
    expect(runner.calls[0]!.join(" ")).toContain("all=false");
  });

  test("304 sends the validators and produces no notifications", async () => {
    const runner = new FakeGh(() => response(304, "", { etag: 'W/"next"', "x-poll-interval": "60" }));
    const result = await pollHost({
      runner,
      host: "github.com",
      cursor: { since: "2026-01-01T00:00:00Z", etag: 'W/"old"', lastModified: "Thu, 01 Jan 2026 00:00:00 GMT" },
      floorMs: 60_000,
      participatingOnly: true,
    });
    expect(result.notifications).toEqual([]);
    expect(result.cursor.etag).toBe('W/"next"');
    const call = runner.calls[0]!.join(" ");
    expect(call).toContain('If-None-Match: W/"old"');
    expect(call).toContain("If-Modified-Since: Thu, 01 Jan 2026 00:00:00 GMT");
  });

  test("a Link next header is reported as more", async () => {
    const runner = new FakeGh(() =>
      response(200, [notification()], { link: '<https://api.github.com/notifications?page=2>; rel="next"' }),
    );
    const config = configWith(["github.com"], [{ host: "github.com", repo: "owner/*" }]);
    const source = createGithubSource(config, { runner, stateFile: join(temp(), "github-state.json") });
    const baseline = await source.events[0]!.poll(null, {}, { maxEvents: 50, now: Date.now() });
    const result = await source.events[0]!.poll(baseline.cursor, {}, { maxEvents: 50, now: Date.now() });
    expect(result.truncated).toBe(true);
  });

  test("X-Poll-Interval never goes below the floor", async () => {
    const runner = new FakeGh(() => response(304, "", { "x-poll-interval": "5" }));
    const result = await pollHost({ runner, host: "github.com", cursor: { since: "2026-01-01T00:00:00Z" }, floorMs: 60_000, participatingOnly: true });
    expect(result.nextPollMs).toBe(60_000);
  });

  test("401 is an authentication error", async () => {
    const runner = new FakeGh(() => response(401));
    await expect(
      pollHost({ runner, host: "github.com", cursor: { since: "2026-01-01T00:00:00Z" }, floorMs: 60_000, participatingOnly: true }),
    ).rejects.toBeInstanceOf(GhAuthError);
  });

  test("a secondary rate limit carries Retry-After", async () => {
    const runner = new FakeGh(() => response(403, { message: "You have exceeded a secondary rate limit" }, { "retry-after": "30" }));
    const error = await pollHost({
      runner,
      host: "github.com",
      cursor: { since: "2026-01-01T00:00:00Z" },
      floorMs: 60_000,
      participatingOnly: true,
    }).catch((value) => value);
    expect(error).toBeInstanceOf(GhRateLimitError);
    expect(error.retryAfterMs).toBe(30_000);
  });

  test("a 403 with no rate-limit signal is an authentication/scope error", async () => {
    const runner = new FakeGh(() => response(403, { message: "Resource not accessible" }));
    await expect(
      pollHost({ runner, host: "github.com", cursor: { since: "2026-01-01T00:00:00Z" }, floorMs: 60_000, participatingOnly: true }),
    ).rejects.toBeInstanceOf(GhAuthError);
  });
});

function configWith(hosts: string[], subscriptions: Config["subscriptions"]): Config {
  return { ...defaultConfig(), hosts, defaultHost: hosts[0]!, subscriptions };
}

describe("GitHub source", () => {
  test("the first poll starts from now and makes one call per host", async () => {
    const runner = new FakeGh(() => response(200, [], { etag: 'W/"x"', "x-poll-interval": "60" }));
    const config = configWith(
      ["github.com", "github.example.com"],
      [
        { host: "github.com", repo: "owner/*" },
        { host: "github.example.com", repo: "owner/*" },
      ],
    );
    const source = createGithubSource(config, { runner, stateFile: join(temp(), "github-state.json"), now: () => Date.parse("2026-01-02T00:00:00Z") });
    const result = await source.events[0]!.poll(null, {}, { maxEvents: 50, now: Date.parse("2026-01-02T00:00:00Z") });
    expect(result.events).toEqual([]);
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls.map(hostOf).sort()).toEqual(["github.com", "github.example.com"]);
    expect(result.cursor).toBeTruthy();
    expect(Object.keys(decodeCursor(result.cursor)!.hosts).sort()).toEqual(["github.com", "github.example.com"]);
  });

  test("emits a review request, a comment and a mention once, and no unsubscribed repository", async () => {
    let call = 0;
    const runner = new FakeGh(() => {
      call++;
      if (call === 1) return response(200, []);
      return response(200, [
        notification({ id: "1", reason: "review_requested" }),
        notification({ id: "2", reason: "comment", updated_at: "2026-01-02T03:05:00Z" }),
        notification({ id: "3", reason: "mention", subject: { type: "Issue", title: "help", url: "https://api.github.com/repos/owner/repo/issues/3" }, updated_at: "2026-01-02T03:06:00Z" }),
        notification({ id: "4", reason: "comment", repository: { full_name: "other/repo", html_url: "https://github.com/other/repo" } }),
      ]);
    });
    const config = configWith(["github.com"], [{ host: "github.com", repo: "owner/*" }]);
    const source = createGithubSource(config, { runner, stateFile: join(temp(), "github-state.json") });
    const first = await source.events[0]!.poll(null, {}, { maxEvents: 50, now: Date.now() });
    const second = await source.events[0]!.poll(first.cursor, {}, { maxEvents: 50, now: Date.now() });
    expect(second.events.map((event) => event.name).sort()).toEqual(["github.mention", "github.pr.comment", "github.pr.review_requested"]);
    expect(new Set(second.events.map((event) => event.eventId)).size).toBe(3);
  });

  test("two hosts produce events in one poll", async () => {
    const runner = new FakeGh((args) => {
      const host = hostOf(args);
      if (host === "github.com") return response(200, [notification({ id: "1" })]);
      return response(200, [
        notification({
          id: "2",
          reason: "mention",
          repository: { full_name: "owner/ghe", html_url: "https://github.example.com/owner/ghe" },
          subject: { type: "Issue", title: "ghe", url: "https://github.example.com/api/v3/repos/owner/ghe/issues/2" },
        }),
      ]);
    });
    const config = configWith(
      ["github.com", "github.example.com"],
      [
        { host: "github.com", repo: "owner/*" },
        { host: "github.example.com", repo: "owner/*" },
      ],
    );
    const source = createGithubSource(config, { runner, stateFile: join(temp(), "github-state.json") });
    // The first poll baselines each host; fake GitHub returns notifications anyway, which are discarded.
    const baseline = await source.events[0]!.poll(null, {}, { maxEvents: 50, now: Date.now() });
    const result = await source.events[0]!.poll(baseline.cursor, {}, { maxEvents: 50, now: Date.now() });
    expect(result.events.map((event) => (event.data as any).host).sort()).toEqual(["github.com", "github.example.com"]);
  });

  test("an auth failure pauses one host and the other continues", async () => {
    const dir = temp();
    const stateFile = join(dir, "github-state.json");
    const calls: string[] = [];
    const runner = new FakeGh((args) => {
      const host = hostOf(args);
      calls.push(host);
      if (host === "github.example.com") return response(401);
      return response(200, []);
    });
    const config = configWith(
      ["github.com", "github.example.com"],
      [
        { host: "github.com", repo: "owner/*" },
        { host: "github.example.com", repo: "owner/*" },
      ],
    );
    const source = createGithubSource(config, { runner, stateFile, pausedRetryMs: 60_000 });
    const first = await source.events[0]!.poll(null, {}, { maxEvents: 50, now: Date.now() });
    expect(first.errors?.some((error) => error.data?.host === "github.example.com")).toBe(true);
    const state = readGithubState(stateFile);
    expect(state.hosts["github.example.com"]!.paused).toBe(true);
    expect(state.hosts["github.com"]!.paused).toBe(false);

    calls.length = 0;
    const second = await source.events[0]!.poll(first.cursor, {}, { maxEvents: 50, now: Date.now() });
    expect(second.errors?.some((error) => error.data?.host === "github.example.com")).toBe(true);
    expect(calls).toEqual(["github.com"]);
  });

  test("rate limiting backs off without pausing the host", async () => {
    const runner = new FakeGh(() => response(403, { message: "secondary rate limit" }, { "retry-after": "30" }));
    const config = configWith(["github.com"], [{ host: "github.com", repo: "owner/*" }]);
    const source = createGithubSource(config, { runner, stateFile: join(temp(), "github-state.json") });
    const result = await source.events[0]!.poll(null, {}, { maxEvents: 50, now: Date.now() });
    expect(result.errors?.[0]?.message).toBe("UpstreamRateLimited");
    expect(result.nextPollMs).toBeGreaterThanOrEqual(30_000);
  });

  test("no subscriptions means no hosts and no calls", async () => {
    const runner = new FakeGh(() => response(200, []));
    const source = createGithubSource(configWith(["github.com"], []), { runner, stateFile: join(temp(), "github-state.json") });
    const result = await source.events[0]!.poll(null, {}, { maxEvents: 50, now: Date.now() });
    expect(result.events).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  test("the hub deduplicates a repeated response", async () => {
    let call = 0;
    const runner = new FakeGh(() => {
      call++;
      if (call === 1) return response(200, []);
      return response(200, [notification({ id: "same", updated_at: "2026-01-02T03:04:05Z" })]);
    });
    const config = configWith(["github.com"], [{ host: "github.com", repo: "owner/*" }]);
    const source = createGithubSource({ ...config, pollFloorSeconds: 0.05 }, { runner, stateFile: join(temp(), "github-state.json") });
    const hub = new EventHub({
      events: source.events,
      store: new MemoryStateStore(),
      limits: { minPollMs: 20 },
      serverInfo: { name: "test", version: "0" },
    });
    const seen: string[] = [];
    const subscription = hub.openStream("github.pr.review_requested", {}, null, 1000, {
      onActive: () => {},
      onEvent: (event) => seen.push(event.eventId),
      onHeartbeat: () => {},
      onError: () => {},
    });
    await Bun.sleep(700);
    subscription.close();
    hub.close();
    expect(seen).toHaveLength(1);
  });
});
