/**
 * Spike: the smallest MCP Events server that OpenCode's client should accept.
 * Protocol 2026-07-28, Streamable HTTP, one fake event type, poll and push.
 * Run: bun spike/server.ts   (listens on 127.0.0.1:8765, token in SPIKE_TOKEN or "spike")
 *
 * Wire details come from the extension spec (modelcontextprotocol/ext-events) and OpenCode's own
 * test fixture (packages/core/test/fixture/event-server.ts). Everything here is unverified
 * against a real OpenCode until the spike checklist in the issue is ticked off.
 */
const PORT = Number(process.env.SPIKE_PORT ?? 8765);
const TOKEN = process.env.SPIKE_TOKEN ?? "spike";
const PROTOCOL = "2026-07-28";
const SUB_ID = "io.modelcontextprotocol/subscriptionId";
const EVERY_MS = Number(process.env.SPIKE_EVERY_MS ?? 10_000);
const HEARTBEAT_MS = 15_000;

const EVENT_TYPE = {
  name: "fake.tick",
  description: "A fake event that fires every few seconds. Only for the spike.",
  delivery: ["push", "poll"],
  inputSchema: { type: "object", properties: {} },
  payloadSchema: {
    type: "object",
    properties: { n: { type: "integer" }, at: { type: "string", format: "date-time" } },
    required: ["n", "at"],
  },
};

// The source of truth: tick n happens at START + n * EVERY_MS. The cursor is just "n", as a string.
const START = Date.now();
const tickCount = () => Math.floor((Date.now() - START) / EVERY_MS);
const occurrence = (n: number) => ({
  eventId: `tick-${n}`,
  name: EVENT_TYPE.name,
  timestamp: new Date(START + n * EVERY_MS).toISOString(),
  data: { n, at: new Date(START + n * EVERY_MS).toISOString() },
  cursor: String(n),
});
/** null means "from now". A cursor from before a restart is ahead of us, so say so with truncated. */
function resolveCursor(c: unknown): { from: number; truncated: boolean } {
  if (c === null || c === undefined) return { from: tickCount(), truncated: false };
  const n = Number(c);
  if (!Number.isInteger(n) || n < 0) return { from: tickCount(), truncated: true };
  if (n > tickCount()) return { from: tickCount(), truncated: true };
  return { from: n, truncated: false };
}

const rpcResult = (id: unknown, result: Record<string, unknown>) => ({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result } });
const rpcError = (id: unknown, code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id, error: { code, message, data } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function authorized(req: Request): Response | null {
  const url = new URL(req.url);
  const host = (req.headers.get("host") ?? "").split(":")[0];
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host!)) return json({ error: "bad host" }, 403);
  const origin = req.headers.get("origin");
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return json({ error: "bad origin" }, 403);
  if (url.pathname === "/health") return null;
  if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return json({ error: "unauthorized" }, 401);
  return null;
}

function stream(id: unknown, params: Record<string, any>, signal: AbortSignal): Response {
  const enc = new TextEncoder();
  const heartbeatMs = Math.min(Math.max(Number(params.heartbeatMs ?? HEARTBEAT_MS), 1000), 30_000);
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const send = (msg: unknown) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(msg)}\n\n`));
      const note = (type: string, p: Record<string, unknown>) =>
        send({ jsonrpc: "2.0", method: `notifications/events/${type}`, params: { ...p, _meta: { [SUB_ID]: id } } });
      let { from, truncated } = resolveCursor(params.cursor);
      note("active", { cursor: String(from), truncated, heartbeatMs });
      let lastSent = Date.now();
      const timer = setInterval(() => {
        try {
          const now = tickCount();
          for (let n = from + 1; n <= now; n++) {
            const o = occurrence(n);
            note("event", o);
            from = n;
            lastSent = Date.now();
          }
          if (Date.now() - lastSent >= heartbeatMs) {
            note("heartbeat", { cursor: String(from) });
            lastSent = Date.now();
          }
        } catch {
          clearInterval(timer);
        }
      }, 1000);
      signal.addEventListener("abort", () => {
        clearInterval(timer);
        try { ctrl.close(); } catch {}
      });
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

export function start(port = PORT) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0, // SSE: never time the stream out ourselves
    async fetch(req) {
      const url = new URL(req.url);
      const deny = authorized(req);
      if (deny) return deny;
      if (url.pathname === "/health") return json({ status: "connected", protocol: PROTOCOL });
      if (url.pathname !== "/mcp") return json({ error: "not found" }, 404);
      if (req.method !== "POST") return new Response(null, { status: 405 });

      let msg: any;
      try { msg = await req.json(); } catch { return json(rpcError(null, -32700, "Parse error"), 400); }
      const { id, method, params = {} } = msg;
      if (id === undefined) return new Response(null, { status: 202 }); // notification (initialized, cancelled)

      // SEP-2243: the event name must be mirrored in the Mcp-Name header.
      if (["events/poll", "events/stream"].includes(method)) {
        const hdr = req.headers.get("mcp-name");
        if (hdr !== params.name) return json(rpcError(id, -32020, "HeaderMismatch", { header: "Mcp-Name" }), 400);
      }

      switch (method) {
        case "server/discover":
          return json(rpcResult(id, {
            supportedVersions: [PROTOCOL],
            capabilities: { extensions: { "io.modelcontextprotocol/events": {} } },
            _meta: { "io.modelcontextprotocol/serverInfo": { name: "github-events-spike", version: "0.0.0" } },
          }));
        case "events/list":
          return json(rpcResult(id, { events: [EVENT_TYPE] }));
        case "events/poll": {
          if (params.name !== EVENT_TYPE.name) return json(rpcError(id, -32023, "NotFound", { kind: "event" }));
          const { from, truncated } = resolveCursor(params.cursor);
          const now = tickCount();
          const max = Math.min(Number(params.maxEvents ?? 50), 50);
          const upto = Math.min(now, from + max);
          const events = [];
          for (let n = from + 1; n <= upto; n++) { const { cursor: _c, ...o } = occurrence(n); events.push(o); }
          return json(rpcResult(id, { events, cursor: String(upto), truncated, hasMore: upto < now, nextPollMs: EVERY_MS }));
        }
        case "events/stream":
          if (params.name !== EVENT_TYPE.name) return json(rpcError(id, -32023, "NotFound", { kind: "event" }));
          return stream(id, params, req.signal);
        default:
          return json(rpcError(id, -32601, "Method not found"));
      }
    },
  });
}

if (import.meta.main) {
  const s = start();
  console.log(`spike server on http://127.0.0.1:${s.port}/mcp  (Authorization: Bearer ${TOKEN}, tick every ${EVERY_MS} ms)`);
}
