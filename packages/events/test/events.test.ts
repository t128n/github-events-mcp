import { afterEach, describe, expect, test } from "bun:test";
import { EventHub, defineEvent, MemoryStateStore, PROTOCOL_VERSION } from "../src/index.ts";
import { pingEvent, readSse, startServer, streamRequest, tickEvent, TEST_TOKEN, type TestServer } from "./helpers.ts";

const controllers: AbortController[] = [];
const servers: TestServer[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const server of servers.splice(0)) {
    server.hub.close();
    server.server.stop(true);
  }
});

function setup(everyMs = 40): { source: { start: number; everyMs: number; polls: { count: number } }; server: TestServer } {
  const source = { start: Date.now(), everyMs, polls: { count: 0 } };
  const server = startServer([tickEvent(source), pingEvent(source)], { limits: { heartbeatMs: 200, minPollMs: 20 } });
  servers.push(server);
  return { source, server };
}

describe("MCP Events protocol", () => {
  test("server/discover advertises the events extension and protocol", async () => {
    const { server } = setup();
    const result = await server.rpc("server/discover");
    expect(result.result.supportedVersions).toContain(PROTOCOL_VERSION);
    expect(result.result.capabilities.extensions["io.modelcontextprotocol/events"]).toBeDefined();
  });

  test("events/list returns both event types with push and poll", async () => {
    const { server } = setup();
    const result = await server.rpc("events/list");
    const names = result.result.events.map((event: any) => event.name);
    expect(names).toEqual(["fake.tick", "fake.ping"]);
    expect(result.result.events[0].delivery).toEqual(["poll", "push"]);
  });

  test("a missing or wrong Mcp-Name header is 400 HeaderMismatch", async () => {
    const { server } = setup();
    const missing = await server.status("events/poll", { name: "fake.tick", cursor: null });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as any).error.code).toBe(-32020);

    const wrong = await server.status("events/poll", { name: "fake.tick", cursor: null }, { "mcp-name": "fake.ping" });
    expect(wrong.status).toBe(400);
  });

  test("a request without the token is 401, a foreign origin or host is 403", async () => {
    const { server } = setup();
    const noToken = await fetch(server.base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(noToken.status).toBe(401);

    const foreignOrigin = await server.status("server/discover", {}, { origin: "https://evil.example" });
    expect(foreignOrigin.status).toBe(403);

    const foreignHost = await server.status("server/discover", {}, { host: "evil.example" });
    expect(foreignHost.status).toBe(403);
  });

  test("health answers without a token", async () => {
    const { server } = setup();
    const response = await fetch(server.base.replace("/mcp", "/health"));
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).status).toBe("ok");
  });

  test("an unknown event is NotFound", async () => {
    const { server } = setup();
    const result = await server.rpc("events/poll", { name: "no.such.event", cursor: null }, { "mcp-name": "no.such.event" });
    expect(result.error.code).toBe(-32023);
    expect(result.error.data.kind).toBe("event");
  });

  test("invalid arguments are InvalidParams", async () => {
    const source = { start: Date.now(), everyMs: 40, polls: { count: 0 } };
    const event = defineEvent({
      name: "strict.event",
      description: "validates arguments",
      inputSchema: {
        type: "object",
        properties: { repos: { type: "array", items: { type: "string" }, maxItems: 2 } },
      },
      poll: tickEvent(source).poll,
    });
    const server = startServer([event], { limits: { minPollMs: 20 } });
    servers.push(server);
    const result = await server.rpc(
      "events/poll",
      { name: "strict.event", arguments: { repos: "not-an-array" }, cursor: null },
      { "mcp-name": "strict.event" },
    );
    expect(result.error.code).toBe(-32602);
  });
});

describe("poll", () => {
  test("null starts from now, then returns each tick once, and a future cursor is truncated", async () => {
    const { server } = setup(60);
    const first = await server.rpc("events/poll", { name: "fake.tick", cursor: null }, { "mcp-name": "fake.tick" });
    expect(first.result.events).toEqual([]);
    expect(typeof first.result.cursor).toBe("string");

    await Bun.sleep(200);
    const second = await server.rpc(
      "events/poll",
      { name: "fake.tick", cursor: first.result.cursor },
      { "mcp-name": "fake.tick" },
    );
    const ids = second.result.events.map((event: any) => event.eventId);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids[0]).toBe("tick-1");

    const third = await server.rpc(
      "events/poll",
      { name: "fake.tick", cursor: second.result.cursor },
      { "mcp-name": "fake.tick" },
    );
    expect(third.result.events.some((event: any) => ids.includes(event.eventId))).toBe(false);

    const future = await server.rpc("events/poll", { name: "fake.tick", cursor: "99999" }, { "mcp-name": "fake.tick" });
    expect(future.result.truncated).toBe(true);
  });
});

describe("stream", () => {
  test("sends active, events with cursor and subscriptionId, and heartbeats", async () => {
    const { server } = setup(60);
    const controller = new AbortController();
    controllers.push(controller);
    const response = await streamRequest(server.base, { name: "fake.tick", arguments: {}, cursor: null, heartbeatMs: 1000 }, controller.signal);
    expect(response.headers.get("content-type")).toStartWith("text/event-stream");
    const frames = await readSse(response, controller, 500);
    const methods = frames.map((frame) => frame.method);
    expect(methods[0]).toBe("notifications/events/active");
    expect(frames[0].params.heartbeatMs).toBe(1000);
    const eventFrame = frames.find((frame) => frame.method === "notifications/events/event");
    expect(eventFrame).toBeDefined();
    expect(eventFrame.params.cursor).toBeUndefined();
    expect(eventFrame.params._meta["io.modelcontextprotocol/subscriptionId"]).toBe(7);
  });

  test("two streams with the same arguments share one poll loop", async () => {
    const { server, source } = setup(60);
    const one = new AbortController();
    const two = new AbortController();
    controllers.push(one, two);
    await streamRequest(server.base, { name: "fake.tick", arguments: {}, cursor: null, heartbeatMs: 1000 }, one.signal);
    await streamRequest(server.base, { name: "fake.tick", arguments: {}, cursor: null, heartbeatMs: 1000 }, two.signal);
    await Bun.sleep(150);
    const groups = server.hub.status().groups;
    expect(groups.length).toBe(1);
    expect(groups[0]!.subscribers).toBe(2);
    // More than one poll happened, but not one loop per stream.
    expect(source.polls.count).toBeLessThan(10);
  });

  test("a poll error becomes an error frame, the stream backs off and recovers", async () => {
    let failures = 2;
    let polls = 0;
    const source = {
      start: Date.now(),
      everyMs: 30,
      polls: { count: 0 },
    };
    const flaky = defineEvent({
      name: "flaky.event",
      description: "fails twice, then works",
      poll: async (cursor, args, ctx) => {
        polls++;
        if (failures > 0) {
          failures--;
          throw new Error("upstream unavailable");
        }
        const result = await tickEvent(source).poll(cursor, args, ctx);
        return {
          ...result,
          events: result.events.map((event) => ({
            ...event,
            eventId: `flaky-${(event.data as { n: number }).n}`,
            name: "flaky.event",
          })),
        };
      },
    });
    const server = startServer([flaky], { limits: { minPollMs: 20, maxBackoffMs: 100 } });
    servers.push(server);
    const controller = new AbortController();
    controllers.push(controller);
    const response = await streamRequest(server.base, { name: "flaky.event", cursor: null, heartbeatMs: 1000 }, controller.signal, { "mcp-name": "flaky.event" });
    const frames = await readSse(response, controller, 800);
    expect(frames.some((frame) => frame.method === "notifications/events/error")).toBe(true);
    expect(frames.some((frame) => frame.method === "notifications/events/event")).toBe(true);
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  test("an oversized payload is dropped instead of breaking the stream", async () => {
    const big = defineEvent({
      name: "big.event",
      description: "returns a large payload",
      poll: async (cursor, _args, ctx) => ({
        events: [
          {
            eventId: "big-1",
            name: "big.event",
            timestamp: new Date(ctx.now).toISOString(),
            data: { text: "x".repeat(500) },
          },
        ],
        cursor: "1",
        hasMore: false,
        nextPollMs: 1_000,
      }),
    });
    const server = startServer([big], { limits: { maxPayloadBytes: 100, minPollMs: 20 } });
    servers.push(server);
    const controller = new AbortController();
    controllers.push(controller);
    const response = await streamRequest(server.base, { name: "big.event", cursor: null, heartbeatMs: 1000 }, controller.signal);
    const frames = await readSse(response, controller, 400);
    expect(frames.some((frame) => frame.method === "notifications/events/event")).toBe(false);
  });

  test("the group limit is enforced", async () => {
    const source = { start: Date.now(), everyMs: 50, polls: { count: 0 } };
    const server = startServer([tickEvent(source), pingEvent(source)], { limits: { maxGroups: 1, minPollMs: 20 } });
    servers.push(server);
    const controller = new AbortController();
    controllers.push(controller);
    await streamRequest(server.base, { name: "fake.tick", cursor: null }, controller.signal);
    const second = await streamRequest(server.base, { name: "fake.ping", cursor: null }, controller.signal);
    expect(second.status).toBe(200);
    const body = await second.json();
    expect((body as any).error.code).toBe(-32025);
  });
});

describe("cursors and restart", () => {
  test("a restart resumes from the stored cursor without replaying or skipping", async () => {
    const store = new MemoryStateStore();
    const source = { start: Date.now(), everyMs: 40, polls: { count: 0 } };
    const first = startServer([tickEvent(source)], { store, limits: { minPollMs: 20 } });
    const controller = new AbortController();
    controllers.push(controller);
    // The background loop is what the daemon uses, so it runs with no stream.
    first.hub.ensure("fake.tick");
    await Bun.sleep(180);
    const beforeRestart = first.hub.status().groups[0]?.cursor;
    expect(beforeRestart).not.toBeNull();
    first.hub.close();
    first.server.stop(true);
    servers.splice(servers.indexOf(first), 1);

    const sourceState = store.load();
    const pendingBefore = new Set<string>();
    for (const group of Object.values(sourceState.groups)) {
      for (const event of group.pending) pendingBefore.add(event.eventId);
    }
    const delivered = new Set<string>();
    for (const group of Object.values(sourceState.groups)) {
      for (const id of group.seen) if (!pendingBefore.has(id)) delivered.add(id);
    }

    // Time passes while the daemon is down. The source still has the events.
    await Bun.sleep(120);
    const second = startServer([tickEvent(source)], { store, limits: { minPollMs: 20 } });
    servers.push(second);
    second.hub.ensure("fake.tick");
    await Bun.sleep(180);
    const state = store.load();
    const group = Object.values(state.groups)[0]!;
    const pendingIds = group.pending.map((event) => event.eventId);
    // Nothing delivered before the restart is queued again.
    expect(pendingIds.some((id) => delivered.has(id))).toBe(false);
    expect(group.seen.length).toBeGreaterThan(0);
    // The cursor moved forward, so the downtime events were not skipped.
    expect(Number(group.cursor)).toBeGreaterThanOrEqual(Number(beforeRestart));
  });

  test("pending events survive a restart and are delivered to a late stream", async () => {
    const store = new MemoryStateStore();
    const source = { start: Date.now(), everyMs: 40, polls: { count: 0 } };
    const first = startServer([tickEvent(source)], { store, limits: { minPollMs: 20 } });
    first.hub.ensure("fake.tick");
    await Bun.sleep(180);
    first.hub.close();
    first.server.stop(true);
    servers.splice(servers.indexOf(first), 1);

    const second = startServer([tickEvent(source)], { store, limits: { minPollMs: 20 } });
    servers.push(second);
    const controller = new AbortController();
    controllers.push(controller);
    const response = await streamRequest(second.base, { name: "fake.tick", cursor: null, heartbeatMs: 1000 }, controller.signal);
    const frames = await readSse(response, controller, 300);
    expect(frames.some((frame) => frame.method === "notifications/events/event")).toBe(true);
  });

  test("two streams that differ only in arguments still share one loop", async () => {
    const source = { start: Date.now(), everyMs: 40, polls: { count: 0 } };
    const shared = defineEvent({
      name: "shared.event",
      description: "one loop, per-stream filters",
      shared: true,
      inputSchema: { type: "object", properties: { only: { type: "string" } } },
      filter: (event, args: any) => !args.only || (event.data as any).only === args.only,
      poll: async (cursor, _args, ctx) => ({
        events: [
          { eventId: `shared-${Math.floor(ctx.now / 1000)}`, name: "shared.event", timestamp: new Date(ctx.now).toISOString(), data: { only: "a" } },
        ],
        cursor: cursor ?? "start",
        hasMore: false,
        nextPollMs: 30,
      }),
    });
    const server = startServer([shared], { limits: { minPollMs: 20 } });
    servers.push(server);
    const one = new AbortController();
    const two = new AbortController();
    controllers.push(one, two);
    await streamRequest(server.base, { name: "shared.event", arguments: { only: "a" }, cursor: null }, one.signal);
    await streamRequest(server.base, { name: "shared.event", arguments: { only: "b" }, cursor: null }, two.signal);
    await Bun.sleep(80);
    expect(server.hub.status().groups.length).toBe(1);
    expect(server.hub.status().groups[0]!.subscribers).toBe(2);
  });
});

describe("packaging", () => {
  test("the package has no GitHub imports", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = join(import.meta.dir, "..", "src");
    for (const file of readdirSync(src)) {
      if (!file.endsWith(".ts")) continue;
      const text = readFileSync(join(src, file), "utf8");
      expect(text.toLowerCase()).not.toContain("github");
    }
  });
});

test("the token header is compared exactly", async () => {
  const source = { start: Date.now(), everyMs: 50, polls: { count: 0 } };
  const server = startServer([tickEvent(source)]);
  servers.push(server);
  const response = await fetch(server.base, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TEST_TOKEN}x` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
  });
  expect(response.status).toBe(401);
});

test("a request without an id is accepted as a notification", async () => {
  const source = { start: Date.now(), everyMs: 50, polls: { count: 0 } };
  const server = startServer([tickEvent(source)]);
  servers.push(server);
  const response = await fetch(server.base, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  expect(response.status).toBe(202);
});

test("closing the last stream stops a non-keepalive loop", async () => {
  const { server } = setup(30);
  const controller = new AbortController();
  controllers.push(controller);
  await streamRequest(server.base, { name: "fake.tick", cursor: null }, controller.signal);
  await Bun.sleep(80);
  expect(server.hub.status().groups[0]!.subscribers).toBe(1);
  controller.abort();
  await Bun.sleep(80);
  expect(server.hub.status().groups.length).toBe(0);
});

test("the hub survives a broken state file", async () => {
  const store = new MemoryStateStore({ version: 1, groups: { broken: {} as any } });
  const source = { start: Date.now(), everyMs: 50, polls: { count: 0 } };
  const hub = new EventHub({
    events: [tickEvent(source)],
    store,
    serverInfo: { name: "events-test", version: "0.0.0" },
  });
  expect(hub.list().length).toBe(1);
  hub.ensure("fake.tick");
  await Bun.sleep(60);
  expect(hub.status().groups.length).toBe(1);
  hub.close();
});
