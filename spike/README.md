# Spike: MCP Events from a Bun server

Answers [#2](https://github.com/t128n/github-events-mcp/issues/2): can OpenCode watch one fake event from a Bun server over Streamable HTTP?

- `server.ts`: minimal server. Protocol `2026-07-28`, one event type `fake.tick`, poll and push, bearer token, loopback only.
- `check.ts`: protocol self-test with a plain `fetch` client. Run `bun spike/check.ts` (13 checks pass). It shows the server follows the spec as I read it. **It does not prove OpenCode accepts it.**

## Run

```sh
bun spike/server.ts            # http://127.0.0.1:8765/mcp, token "spike", a tick every 10 s
SPIKE_TOKEN=secret SPIKE_EVERY_MS=5000 bun spike/server.ts
```

## Try it in OpenCode (not done yet)

1. Enable the experimental flag for MCP events. The exact flag and config key are unverified.
2. Add a remote MCP server for `http://127.0.0.1:8765/mcp` with the header `Authorization: Bearer spike`. OpenCode's own tests set `protocol: "2026-07-28"` for such servers, so that probably has to be configured too.
3. List the event types, then watch `fake.tick`. Confirm a session wakes up.
4. Kill the server and restart it. Confirm the client reconnects. After a restart the tick counter starts again, so the old cursor lies in the future and the server answers `truncated: true`.

## Known gaps

- No `initialize` handshake. The 2026-07-28 protocol uses `server/discover`, and OpenCode's test fixture does the same. If OpenCode still sends `initialize` first, add it.
- No `subscriptions/listen`, so no `list_changed`.
- Webhook delivery is left out on purpose.
- Cursor and tick state live in memory only.
