import { EventHub, createEventsHandler, defineEvent, FileStateStore, MemoryStateStore, type EventDefinition } from "../src/index.ts";

export const TEST_TOKEN = "test-token";

export function tickEvent(source: { start: number; everyMs: number; polls: { count: number } }): EventDefinition {
  return defineEvent({
    name: "fake.tick",
    description: "A fake tick, for tests.",
    payloadSchema: { type: "object", properties: { n: { type: "integer" } } },
    poll: async (cursor, _args, ctx) => {
      source.polls.count++;
      const now = Math.floor((ctx.now - source.start) / source.everyMs);
      if (cursor === null || cursor === undefined) {
        return { events: [], cursor: String(now), hasMore: false, nextPollMs: source.everyMs };
      }
      const from = Number(cursor);
      if (!Number.isInteger(from) || from < 0 || from > now) {
        return { events: [], cursor: String(now), truncated: true, hasMore: false, nextPollMs: source.everyMs };
      }
      const upto = Math.min(now, from + ctx.maxEvents);
      const events = [];
      for (let n = from + 1; n <= upto; n++) {
        events.push({
          eventId: `tick-${n}`,
          name: "fake.tick",
          timestamp: new Date(source.start + n * source.everyMs).toISOString(),
          data: { n },
        });
      }
      return { events, cursor: String(upto), hasMore: upto < now, nextPollMs: source.everyMs };
    },
  });
}

export function pingEvent(source: { start: number; everyMs: number; polls: { count: number } }): EventDefinition {
  return defineEvent({
    name: "fake.ping",
    description: "A second fake event type, for tests.",
    payloadSchema: { type: "object", properties: { n: { type: "integer" } } },
    poll: async (cursor, _args, ctx) => {
      source.polls.count++;
      const now = Math.floor((ctx.now - source.start) / source.everyMs);
      if (cursor === null || cursor === undefined) {
        return { events: [], cursor: String(now), hasMore: false, nextPollMs: source.everyMs };
      }
      const from = Number(cursor);
      if (!Number.isInteger(from) || from < 0 || from > now) {
        return { events: [], cursor: String(now), truncated: true, hasMore: false, nextPollMs: source.everyMs };
      }
      const events = [];
      for (let n = from + 1; n <= now; n++) {
        events.push({
          eventId: `ping-${n}`,
          name: "fake.ping",
          timestamp: new Date(source.start + n * source.everyMs).toISOString(),
          data: { n },
        });
      }
      return { events, cursor: String(now), hasMore: false, nextPollMs: source.everyMs };
    },
  });
}

export interface TestServer {
  hub: EventHub;
  base: string;
  server: { stop(force?: boolean): void };
  rpc(method: string, params?: Record<string, unknown>, headers?: Record<string, string>, id?: number): Promise<any>;
  status(method: string, params?: Record<string, unknown>, headers?: Record<string, string>): Promise<Response>;
}

export function startServer(
  events: EventDefinition[],
  options: { store?: MemoryStateStore | FileStateStore; limits?: Record<string, number>; now?: () => number } = {},
): TestServer {
  const hub = new EventHub({
    events,
    store: options.store ?? new MemoryStateStore(),
    limits: options.limits,
    now: options.now,
    serverInfo: { name: "events-test", version: "0.0.0" },
  });
  const handler = createEventsHandler({
    getHub: () => hub,
    token: TEST_TOKEN,
    serverInfo: { name: "events-test", version: "0.0.0" },
    health: () => ({ lastPollAt: hub.status().lastPollAt }),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: handler });
  const base = `http://127.0.0.1:${server.port}/mcp`;
  const headers = (extra: Record<string, string> = {}) => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${TEST_TOKEN}`,
    ...extra,
  });
  return {
    hub,
    base,
    server,
    status: (method, params = {}, extra = {}) =>
      fetch(base, { method: "POST", headers: headers(extra), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }),
    rpc: async (method, params = {}, extra = {}, id = 1) =>
      (await fetch(base, {
        method: "POST",
        headers: headers(extra),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      })).json(),
  };
}

/** Reads SSE frames until the deadline, then aborts. Returns the decoded JSON messages. */
export async function readSse(response: Response, controller: AbortController, ms: number): Promise<any[]> {
  const seen: any[] = [];
  let buffer = "";
  const decoder = new TextDecoder();
  const deadline = Date.now() + ms;
  try {
    for await (const chunk of response.body as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (frame.startsWith("data: ")) seen.push(JSON.parse(frame.slice(6)));
      }
      if (Date.now() > deadline) break;
    }
  } catch {
    // aborted on purpose
  }
  controller.abort();
  return seen;
}

export function streamRequest(base: string, params: Record<string, unknown>, signal: AbortSignal, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(base, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TEST_TOKEN}`,
      "mcp-name": String(params.name),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "events/stream", params }),
  });
}
