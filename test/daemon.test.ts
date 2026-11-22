import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineEvent } from "@github-events-mcp/events";
import { startDaemon } from "../src/daemon/daemon.ts";
import { choosePort } from "../src/commands/setup.ts";
import { defaultConfig, saveConfig, type Config } from "../src/config/config.ts";
import type { EventSource, SourceFactory } from "../src/daemon/source.ts";

const dirs: string[] = [];
const daemons: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const daemon of daemons.splice(0)) daemon.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "github-events-daemon-"));
  dirs.push(dir);
  return dir;
}

function fakeFactory(state: { polls: number }): SourceFactory {
  return (): EventSource => ({
    events: [
      defineEvent({
        name: "demo.tick",
        description: "A test event.",
        poll: async (cursor, _args, ctx) => {
          state.polls++;
          return { events: [], cursor: cursor ?? String(ctx.now), hasMore: false, nextPollMs: 30 };
        },
      }),
    ],
    health: () => ({ source: "fake" }),
  });
}

async function health(port: number): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  return response.json();
}

async function configWith(subscriptions: Config["subscriptions"]): Promise<Config> {
  return {
    ...defaultConfig(),
    port: await choosePort(0),
    hosts: ["github.com", "github.example.com"],
    subscriptions,
  };
}

describe("daemon", () => {
  test("serves health, rejects a missing token and a foreign origin", async () => {
    const dir = temp();
    const token = "daemon-token";
    const daemon = startDaemon({
      config: await configWith([{ host: "github.com", repo: "owner/repo" }]),
      token,
      factory: fakeFactory({ polls: 0 }),
      stateFile: join(dir, "state.json"),
      watchConfig: false,
    });
    daemons.push(daemon);

    const body = await health(daemon.port);
    expect(body.status).toBe("ok");
    expect(body.source).toBe("fake");
    expect(body.subscriptions).toBe(1);

    const base = `http://127.0.0.1:${daemon.port}/mcp`;
    const noToken = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(noToken.status).toBe(401);

    const foreign = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, origin: "https://evil.example" },
      body: "{}",
    });
    expect(foreign.status).toBe(403);

    const discover = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/list" }),
    });
    expect(discover.status).toBe(200);
    const result = (await discover.json()) as any;
    expect(result.result.events[0].name).toBe("demo.tick");
  });

  test("polls when subscribed and nothing when there are no subscriptions", async () => {
    const dir = temp();
    const state = { polls: 0 };
    const subscribed = startDaemon({
      config: await configWith([{ host: "github.com", repo: "owner/repo" }]),
      token: "t",
      factory: fakeFactory(state),
      stateFile: join(dir, "state.json"),
      watchConfig: false,
    });
    daemons.push(subscribed);
    await Bun.sleep(120);
    expect(state.polls).toBeGreaterThan(0);
    expect((await health(subscribed.port)).groups.length).toBe(1);
    subscribed.stop();

    const idle = startDaemon({
      config: await configWith([]),
      token: "t",
      factory: fakeFactory(state),
      stateFile: join(dir, "state-2.json"),
      watchConfig: false,
    });
    daemons.push(idle);
    const before = state.polls;
    await Bun.sleep(120);
    expect(state.polls).toBe(before);
    expect((await health(idle.port)).groups).toEqual([]);
  });

  test("reload swaps the source and starts or stops polling without a restart", async () => {
    const dir = temp();
    const configFile = join(dir, "config.json");
    const state = { polls: 0 };
    let config = await configWith([{ host: "github.com", repo: "owner/repo" }]);
    saveConfig(config, configFile);
    const daemon = startDaemon({
      config,
      token: "t",
      factory: fakeFactory(state),
      configFile,
      stateFile: join(dir, "state.json"),
      watchConfig: false,
    });
    daemons.push(daemon);
    await Bun.sleep(80);
    expect((await health(daemon.port)).subscriptions).toBe(1);
    expect(state.polls).toBeGreaterThan(0);

    config = { ...config, subscriptions: [] };
    saveConfig(config, configFile);
    await daemon.reload();
    expect((await health(daemon.port)).subscriptions).toBe(0);
    expect((await health(daemon.port)).groups).toEqual([]);
    const after = state.polls;
    await Bun.sleep(100);
    expect(state.polls).toBe(after);

    config = { ...config, subscriptions: [{ host: "github.com", repo: "owner/other" }] };
    saveConfig(config, configFile);
    await daemon.reload();
    expect((await health(daemon.port)).subscriptions).toBe(1);
    await Bun.sleep(80);
    expect(state.polls).toBeGreaterThan(after);
  });

  test("the authenticated admin endpoint reloads the config", async () => {
    const dir = temp();
    const configFile = join(dir, "config.json");
    const token = "admin-token";
    let config = await configWith([]);
    saveConfig(config, configFile);
    const daemon = startDaemon({
      config,
      token,
      factory: fakeFactory({ polls: 0 }),
      configFile,
      stateFile: join(dir, "state.json"),
      watchConfig: false,
    });
    daemons.push(daemon);
    config = { ...config, subscriptions: [{ host: "github.com", repo: "owner/repo" }] };
    saveConfig(config, configFile);
    const unauthorized = await fetch(`http://127.0.0.1:${daemon.port}/admin/reload`, { method: "POST" });
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`http://127.0.0.1:${daemon.port}/admin/reload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect((await health(daemon.port)).subscriptions).toBe(1);
  });

  test("a malformed reload keeps the old source", async () => {
    const dir = temp();
    const configFile = join(dir, "config.json");
    const state = { polls: 0 };
    const config = await configWith([{ host: "github.com", repo: "owner/repo" }]);
    saveConfig(config, configFile);
    const daemon = startDaemon({
      config,
      token: "t",
      factory: fakeFactory(state),
      configFile,
      stateFile: join(dir, "state.json"),
      watchConfig: false,
      log: () => {},
    });
    daemons.push(daemon);
    writeFileSync(configFile, "{ not json");
    await expect(daemon.reload()).rejects.toThrow();
    expect((await health(daemon.port)).subscriptions).toBe(1);
  });
});
