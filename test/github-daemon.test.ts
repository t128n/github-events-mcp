import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon/daemon.ts";
import { choosePort } from "../src/commands/setup.ts";
import { defaultConfig, type Config } from "../src/config/config.ts";
import { createGithubSource } from "../src/github/source.ts";
import type { GhResponse, GhRunner } from "../src/github/runner.ts";
import { readSse } from "../packages/events/test/helpers.ts";

const dirs: string[] = [];
const daemons: RunningDaemon[] = [];
afterEach(() => {
  for (const daemon of daemons.splice(0)) daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "github-events-e2e-"));
  dirs.push(dir);
  return dir;
}

function ghResponse(status: number, body: unknown = [], headers: Record<string, string> = {}): GhResponse {
  return { status, headers, body: JSON.stringify(body), stderr: "", exitCode: status >= 400 ? 1 : 0 };
}

class FakeGh implements GhRunner {
  calls: string[][] = [];
  constructor(private readonly handler: (args: string[]) => GhResponse) {}
  async run(args: string[]): Promise<GhResponse> {
    this.calls.push(args);
    return this.handler(args);
  }
}

const mention = {
  id: "77",
  reason: "mention",
  updated_at: "2026-01-02T03:04:05Z",
  repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
  subject: { type: "Issue", title: "Please look", url: "https://api.github.com/repos/owner/repo/issues/4" },
};

async function start(config: Config, runner: GhRunner, stateFile: string): Promise<RunningDaemon> {
  const daemon = startDaemon({
    config,
    token: "e2e-token",
    factory: (current) => createGithubSource(current, { runner, stateFile }),
    stateFile: join(temp(), "events-state.json"),
    watchConfig: false,
    log: () => {},
  });
  daemons.push(daemon);
  return daemon;
}

function sse(daemon: RunningDaemon, name: string, signal: AbortSignal): Promise<Response> {
  return fetch(`http://127.0.0.1:${daemon.port}/mcp`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer e2e-token",
      "mcp-name": name,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "events/stream", params: { name, arguments: {}, cursor: null, heartbeatMs: 1000 } }),
  });
}

describe("GitHub source through the daemon", () => {
  test("a mention arrives over SSE and health reports the host", async () => {
    const dir = temp();
    let baseline = true;
    const runner = new FakeGh(() => {
      if (baseline) {
        baseline = false;
        return ghResponse(200, []);
      }
      return ghResponse(200, [mention]);
    });
    const config: Config = {
      ...defaultConfig(),
      port: await choosePort(0),
      pollFloorSeconds: 0.05,
      subscriptions: [{ host: "github.com", repo: "owner/*", events: ["github.mention"] }],
    };
    const daemon = await start(config, runner, join(dir, "github-state.json"));

    const controller = new AbortController();
    const response = await sse(daemon, "github.mention", controller.signal);
    expect(response.headers.get("content-type")).toStartWith("text/event-stream");
    const frames = await readSse(response, controller, 1_400);
    const event = frames.find((frame) => frame.method === "notifications/events/event");
    expect(event).toBeDefined();
    expect(event.params.name).toBe("github.mention");
    expect(event.params.data.threadId).toBe("77");
    expect(event.params.data.url).toBe("https://github.com/owner/repo/issues/4");

    const health = await (await fetch(`http://127.0.0.1:${daemon.port}/health`)).json() as any;
    expect(health.github.hosts).toBe(1);
    expect(health.github.paused).toBe(0);
  });

  test("with no subscriptions the daemon makes no gh call", async () => {
    const runner = new FakeGh(() => ghResponse(200, []));
    const config: Config = { ...defaultConfig(), port: await choosePort(0), pollFloorSeconds: 0.05, subscriptions: [] };
    const daemon = await start(config, runner, join(temp(), "github-state.json"));
    await Bun.sleep(400);
    expect(runner.calls).toEqual([]);
  });

  test("an auth failure shows as paused in health", async () => {
    const runner = new FakeGh(() => ghResponse(401));
    const config: Config = {
      ...defaultConfig(),
      port: await choosePort(0),
      pollFloorSeconds: 0.05,
      subscriptions: [{ host: "github.com", repo: "owner/*", events: ["github.mention"] }],
    };
    const daemon = await start(config, runner, join(temp(), "github-state.json"));
    await Bun.sleep(400);
    const health = await (await fetch(`http://127.0.0.1:${daemon.port}/health`)).json() as any;
    expect(health.github.paused).toBe(1);
  });
});
