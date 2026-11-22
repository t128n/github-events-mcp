import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type Config } from "../src/config/config.ts";
import {
  createRepoDiscovery,
  createdMatches,
  ciMatches,
  decodeRepoCursor,
  encodeRepoCursor,
  pollCi,
  pollCreated,
  reposForEvent,
  simpleGlob,
  type CiCursor,
  type CreatedCursor,
  type RepoDiscovery,
} from "../src/github/repos.ts";
import { createGithubSource } from "../src/github/source.ts";
import { readGithubState } from "../src/github/state.ts";
import type { GhResponse, GhRunner } from "../src/github/runner.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "github-events-repos-"));
  dirs.push(dir);
  return dir;
}

function response(status: number, body: unknown = [], headers: Record<string, string> = {}): GhResponse {
  return { status, headers, body: typeof body === "string" ? body : JSON.stringify(body), stderr: "", exitCode: status >= 400 ? 1 : 0 };
}

class FakeGh implements GhRunner {
  calls: string[][] = [];
  constructor(private readonly handler: (path: string, args: string[]) => GhResponse | Promise<GhResponse>) {}
  async run(args: string[]): Promise<GhResponse> {
    this.calls.push(args);
    const path = args.find((arg) => arg.startsWith("/repos/") || arg.startsWith("/orgs/") || arg.startsWith("/users/")) ?? "";
    return this.handler(path, args);
  }
}

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1001,
    number: 7,
    title: "A new issue",
    html_url: "https://github.com/owner/repo/issues/7",
    user: { login: "alice" },
    created_at: "2026-01-02T03:04:05Z",
    updated_at: "2026-01-02T03:04:05Z",
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 55,
    run_attempt: 1,
    name: "CI",
    head_branch: "main",
    conclusion: "failure",
    event: "push",
    html_url: "https://github.com/owner/repo/actions/runs/55",
    updated_at: "2026-01-02T03:04:05Z",
    ...overrides,
  };
}

function configWith(subscriptions: Config["subscriptions"]): Config {
  return { ...defaultConfig(), hosts: ["github.com"], subscriptions };
}

describe("created events", () => {
  test("baseline emits nothing, then a new issue and pull request each emit once", async () => {
    const now = Date.parse("2026-01-02T04:00:00Z");
    let call = 0;
    const runner = new FakeGh(() => {
      call++;
      if (call === 1) return response(200, [issue({ created_at: "2026-01-02T03:00:00Z", updated_at: "2026-01-02T03:00:00Z" })], { etag: 'W/"old"' });
      return response(200, [
        issue({ id: 1003, created_at: "2026-01-02T04:01:00Z", updated_at: "2026-01-02T04:01:00Z" }),
        issue({ id: 1002, number: 8, title: "A new PR", html_url: "https://github.com/owner/repo/pull/8", created_at: "2026-01-02T04:02:00Z", updated_at: "2026-01-02T04:02:00Z", pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/8" } }),
        issue({ id: 1000, number: 6, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T03:00:00Z" }),
      ]);
    });
    const cursor: CreatedCursor = { since: "2026-01-02T03:59:00Z", createdAt: "2026-01-02T04:00:00Z" };
    const baseline = await pollCreated({ runner, host: "github.com", repo: "owner/repo", floorMs: 60_000, cursor, now: () => now, baseline: true });
    expect(baseline.events).toEqual([]);

    const result = await pollCreated({ runner, host: "github.com", repo: "owner/repo", floorMs: 60_000, cursor: baseline.cursor, now: () => now });
    expect(result.events.map((event) => event.name).sort()).toEqual(["github.issue.created", "github.pr.created"]);
    expect(result.events.find((event) => event.name === "github.issue.created")!.data).toMatchObject({
      host: "github.com",
      repo: "owner/repo",
      number: 7,
      title: "A new issue",
      author: "alice",
      subjectType: "Issue",
    });

    const repeated = await pollCreated({ runner, host: "github.com", repo: "owner/repo", floorMs: 60_000, cursor: result.cursor, now: () => now });
    expect(repeated.events).toEqual([]);

    const notModified = await pollCreated({
      runner: new FakeGh(() => response(304, "", { etag: 'W/"same"' })),
      host: "github.com",
      repo: "owner/repo",
      floorMs: 60_000,
      cursor: { ...result.cursor, etag: 'W/"same"' },
      now: () => now,
    });
    expect(notModified.events).toEqual([]);
  });

  test("a quiet 200 keeps the validators for the next conditional poll", async () => {
    const runner = new FakeGh(() => response(200, [], { etag: 'W/"quiet"', "last-modified": "Thu, 01 Jan 2026 00:00:00 GMT" }));
    const cursor: CreatedCursor = { since: "2026-01-02T03:59:00Z", createdAt: "2026-01-02T04:00:00Z" };
    const result = await pollCreated({ runner, host: "github.com", repo: "owner/repo", floorMs: 60_000, cursor, now: () => Date.parse("2026-01-02T04:01:00Z") });
    expect(result.events).toEqual([]);
    expect(result.cursor.etag).toBe('W/"quiet"');
    expect(result.cursor.since).toBe(cursor.since);
  });

  test("filters by repository and author", () => {
    const data = {
      host: "github.com",
      repo: "owner/repo",
      number: 1,
      title: "t",
      url: "u",
      author: "alice",
      subjectType: "Issue" as const,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(createdMatches(data, {})).toBe(true);
    expect(createdMatches(data, { repos: ["owner/*"] })).toBe(true);
    expect(createdMatches(data, { repos: ["other/*"] })).toBe(false);
    expect(createdMatches(data, { authors: ["al*"] })).toBe(true);
    expect(createdMatches(data, { authors: ["bob"] })).toBe(false);
  });
});

describe("CI events", () => {
  test("baseline emits nothing, a failed run on main emits once, a success emits nothing", async () => {
    const now = Date.parse("2026-01-02T04:00:00Z");
    let call = 0;
    const runner = new FakeGh(() => {
      call++;
      if (call === 1) return response(200, { workflow_runs: [run({ id: 50, conclusion: "success" })] }, { etag: 'W/"old"' });
      return response(200, {
        workflow_runs: [
          run({ updated_at: "2026-01-02T04:01:00Z" }),
          run({ id: 56, conclusion: "success", head_branch: "feature", updated_at: "2026-01-02T04:02:00Z" }),
          run({ id: 57, conclusion: "timed_out", head_branch: "release/1", updated_at: "2026-01-02T04:03:00Z" }),
        ],
      });
    });
    const cursor: CiCursor = { lastUpdatedAt: "2026-01-02T04:00:00Z" };
    const baseline = await pollCi({ runner, host: "github.com", repo: "owner/repo", floorMs: 60_000, cursor, now: () => now, baseline: true });
    expect(baseline.events).toEqual([]);

    const result = await pollCi({ runner, host: "github.com", repo: "owner/repo", floorMs: 60_000, cursor: baseline.cursor, now: () => now });
    expect(result.events.map((event) => event.name)).toEqual(["github.ci.failed", "github.ci.failed"]);
    expect(result.events[0]!.data).toMatchObject({ branch: "main", workflow: "CI", conclusion: "failure", event: "push" });
    expect(result.events[1]!.data).toMatchObject({ branch: "release/1", conclusion: "timed_out" });

    const repeated = await pollCi({ runner, host: "github.com", repo: "owner/repo", floorMs: 60_000, cursor: result.cursor, now: () => now });
    expect(repeated.events).toEqual([]);
  });

  test("filters branches, workflows and conclusions", () => {
    const data = {
      host: "github.com",
      repo: "owner/repo",
      branch: "main",
      workflow: "CI",
      conclusion: "failure",
      event: "push",
      runId: "1",
      attempt: 1,
      url: "u",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    expect(ciMatches(data, {})).toBe(true);
    expect(ciMatches(data, { branches: ["main"] })).toBe(true);
    expect(ciMatches(data, { branches: ["release/*"] })).toBe(false);
    expect(ciMatches(data, { workflows: ["C?"] })).toBe(true);
    expect(ciMatches(data, { workflows: ["Build *"] })).toBe(false);
    expect(ciMatches(data, { conclusions: ["failure"] })).toBe(true);
    expect(ciMatches(data, { conclusions: ["timed_out"] })).toBe(false);
  });
});

describe("repository discovery", () => {
  const disallow = (): never => {
    throw new Error("should not discover an exact subscription");
  };
  const discovery: RepoDiscovery = {
    repos: async () => ["owner/a", "owner/b"],
    clear: () => {},
  };

  test("expands owner/* but not an exact repository", async () => {
    const wildcard = configWith([{ host: "github.com", repo: "owner/*", events: ["github.ci.failed"] }]);
    expect(await reposForEvent(wildcard, discovery, "github.ci.failed")).toEqual([
      { host: "github.com", repo: "owner/a" },
      { host: "github.com", repo: "owner/b" },
    ]);

    const exact = configWith([{ host: "github.com", repo: "owner/a", events: ["github.ci.failed"] }]);
    expect(await reposForEvent(exact, disallow as unknown as RepoDiscovery, "github.ci.failed")).toEqual([
      { host: "github.com", repo: "owner/a" },
    ]);
  });

  test("does not resolve when the subscription does not include the event", async () => {
    const config = configWith([{ host: "github.com", repo: "owner/*", events: ["github.mention"] }]);
    expect(await reposForEvent(config, disallow as unknown as RepoDiscovery, "github.ci.failed")).toEqual([]);
  });

  test("lists org repos and falls back to user repos", async () => {
    const runner = new FakeGh((path) => {
      if (path.startsWith("/orgs/owner/repos")) return response(404);
      if (path.startsWith("/users/owner/repos")) return response(200, [{ full_name: "owner/a" }, { full_name: "owner/archived", archived: true }]);
      return response(404);
    });
    const discovery = createRepoDiscovery({ runner, now: () => 0 });
    expect(await discovery.repos("github.com", "owner")).toEqual(["owner/a"]);
  });
});

test("the source advertises the created and CI event types", () => {
  const source = createGithubSource(configWith([]), {
    runner: new FakeGh(() => response(200, [])),
    stateFile: join(temp(), "github-state.json"),
  });
  const names = source.events.map((event) => event.name);
  expect(names).toContain("github.issue.created");
  expect(names).toContain("github.pr.created");
  expect(names).toContain("github.ci.failed");
});

describe("repo cursor", () => {
  test("round-trips and rejects garbage", () => {
    const cursor = { v: 1 as const, repos: { "github.com/owner/repo": { created: { since: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" } } } };
    expect(decodeRepoCursor(encodeRepoCursor(cursor))).toEqual(cursor);
    expect(decodeRepoCursor("nope")).toBeUndefined();
  });
});

describe("GitHub source with created and CI events", () => {
  test("baseline then new issue, PR and failed run in one poll", async () => {
    const dir = temp();
    const base = Date.parse("2026-01-02T04:00:00Z");
    let issueCalls = 0;
    let runCalls = 0;
    const runner = new FakeGh((path) => {
      if (path.startsWith("/orgs/owner/repos")) return response(200, [{ full_name: "owner/repo" }]);
      if (path.includes("/issues?")) {
        issueCalls++;
        if (issueCalls === 1) return response(200, []);
        return response(200, [
          issue({ id: 1003, created_at: "2026-01-02T04:01:00Z", updated_at: "2026-01-02T04:01:00Z" }),
          issue({ id: 1002, number: 8, title: "A new PR", html_url: "https://github.com/owner/repo/pull/8", created_at: "2026-01-02T04:02:00Z", updated_at: "2026-01-02T04:02:00Z", pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/8" } }),
        ]);
      }
      if (path.includes("/actions/runs?")) {
        runCalls++;
        if (runCalls === 1) return response(200, { workflow_runs: [] });
        return response(200, { workflow_runs: [run({ updated_at: "2026-01-02T04:03:00Z" })] });
      }
      return response(404);
    });
    const config: Config = {
      ...defaultConfig(),
      pollFloorSeconds: 0.05,
      subscriptions: [{ host: "github.com", repo: "owner/*", events: ["github.issue.created", "github.pr.created", "github.ci.failed"] }],
    };
    const source = createGithubSource(config, { runner, stateFile: join(dir, "github-state.json"), now: () => base });
    const poll = source.events.find((event) => event.name === "github.issue.created")!.poll;
    const baseline = await poll(null, {}, { maxEvents: 50, now: base });
    expect(baseline.events).toEqual([]);
    const result = await poll(baseline.cursor, {}, { maxEvents: 50, now: base });
    expect(result.events.map((event) => event.name).sort()).toEqual(["github.ci.failed", "github.issue.created", "github.pr.created"]);
    expect(result.events.find((event) => event.name === "github.ci.failed")!.data).toMatchObject({ branch: "main", repo: "owner/repo" });
  });

  test("does not poll notifications when only created/CI events are subscribed", async () => {
    const dir = temp();
    const runner = new FakeGh((path) => {
      if (path.startsWith("/orgs/owner/repos")) return response(200, [{ full_name: "owner/repo" }]);
      if (path.includes("/issues?")) return response(200, []);
      if (path.includes("/actions/runs?")) return response(200, { workflow_runs: [] });
      return response(404);
    });
    const config: Config = {
      ...defaultConfig(),
      subscriptions: [{ host: "github.com", repo: "owner/*", events: ["github.issue.created", "github.pr.created", "github.ci.failed"] }],
    };
    const source = createGithubSource(config, { runner, stateFile: join(dir, "github-state.json") });
    const notificationPoll = source.events.find((event) => event.name === "github.mention")!.poll;
    const before = runner.calls.length;
    const result = await notificationPoll(null, {}, { maxEvents: 50, now: Date.now() });
    expect(result.events).toEqual([]);
    expect(runner.calls.length).toBe(before);
  });

  test("an auth failure in the repo poll pauses the host", async () => {
    const dir = temp();
    const stateFile = join(dir, "github-state.json");
    const source = createGithubSource(configWith([{ host: "github.com", repo: "owner/repo", events: ["github.ci.failed"] }]), {
      runner: new FakeGh((path) => (path.includes("/actions/runs?") ? response(401) : response(404))),
      stateFile,
    });
    const poll = source.events.find((event) => event.name === "github.ci.failed")!.poll;
    const result = await poll(null, {}, { maxEvents: 50, now: Date.now() });
    expect(result.errors?.[0]?.code).toBe(-32024);
    expect(readGithubState(stateFile).hosts["github.com"]!.paused).toBe(true);
  });

  test("does not poll repositories when only notification events are subscribed", async () => {
    const dir = temp();
    const runner = new FakeGh(() => response(200, []));
    const config: Config = {
      ...defaultConfig(),
      subscriptions: [{ host: "github.com", repo: "owner/*", events: ["github.mention"] }],
    };
    const source = createGithubSource(config, { runner, stateFile: join(dir, "github-state.json") });
    const repoPoll = source.events.find((event) => event.name === "github.issue.created")!.poll;
    const result = await repoPoll(null, {}, { maxEvents: 50, now: Date.now() });
    expect(result.events).toEqual([]);
    expect(runner.calls).toEqual([]);
  });
});

test("simpleGlob treats * and ?", () => {
  expect(simpleGlob("release/*", "release/1", true)).toBe(true);
  expect(simpleGlob("C?", "CI", true)).toBe(true);
  expect(simpleGlob("main", "MAIN", true)).toBe(false);
  expect(simpleGlob("MAIN", "main", false)).toBe(true);
});
