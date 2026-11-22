# @github-events-mcp/events

The protocol and poll-loop half of an MCP Events server. It has no GitHub (or mail, or Slack) code: an event type supplies a `poll` function and this package does the JSON-RPC, SSE, cursor and back-off work.

```ts
import { defineEvent, EventHub, createEventsHandler } from "@github-events-mcp/events";

const tick = defineEvent({
  name: "demo.tick",
  description: "Fires once a minute.",
  inputSchema: { type: "object", properties: {} },
  payloadSchema: { type: "object", properties: { n: { type: "integer" } } },
  poll: async (cursor, args, { maxEvents, now }) => ({
    events: [],
    cursor: cursor ?? String(now),
    hasMore: false,
    nextPollMs: 60_000,
  }),
});

const hub = new EventHub({ events: [tick], serverInfo: { name: "demo", version: "1.0.0" } });
Bun.serve({ hostname: "127.0.0.1", port: 8765, fetch: createEventsHandler({ getHub: () => hub, token: "secret", serverInfo: { name: "demo", version: "1.0.0" } }) });
```

## What it covers

- `server/discover`, `initialize`, `events/list`, `events/poll`, `events/stream` (SSE) over Streamable HTTP, protocol `2026-07-28`.
- `Mcp-Name` header validation, `-32020 HeaderMismatch`, `-32023 NotFound`, `-32025 ResourceExhausted`.
- One poll loop per group. Event types that share a `group` share a loop; `shared: true` also shares it across different arguments, and each stream filters with `filter`.
- Push streams send `notifications/events/active`, `event`, `heartbeat` and `error`, with `_meta["io.modelcontextprotocol/subscriptionId"]`.
- Opaque cursors persisted per group in a JSON state file, plus a bounded queue of events polled while no stream was attached. A restart resumes instead of replaying or skipping.
- A failed poll sends `notifications/events/error` and backs off; it does not end the stream.
- Caps on payload size, batch size, pending events, remembered event ids and the number of groups.

Payloads are plain JSON and thin. The package treats them as data; it never interprets an upstream payload.
