/** Talks to the spike server like a client would. Run: bun spike/check.ts (starts its own server on a free port). */
process.env.SPIKE_EVERY_MS = "1000"; // must be set before the server module loads
const { start } = await import("./server.ts");
const s = start(0);
const base = `http://127.0.0.1:${s.port}/mcp`;
const H = (extra: Record<string, string> = {}) => ({ "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer spike", ...extra });
const rpc = async (method: string, params: any = {}, id = 1, headers: Record<string, string> = {}) =>
  (await fetch(base, { method: "POST", headers: H(headers), body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })).json() as Promise<any>;
let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) { failed++; if (detail !== undefined) console.log("      ", JSON.stringify(detail)); } };

const d = await rpc("server/discover");
ok("discover advertises events", !!d.result?.capabilities?.extensions?.["io.modelcontextprotocol/events"], d);
const l = await rpc("events/list");
ok("events/list returns fake.tick with push+poll", l.result?.events?.[0]?.name === "fake.tick" && l.result.events[0].delivery.includes("push"), l);
const bad = await fetch(base, { method: "POST", headers: H({ "mcp-name": "wrong" }), body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "events/poll", params: { name: "fake.tick", cursor: null } }) });
ok("Mcp-Name mismatch is 400", bad.status === 400);
const noauth = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
ok("no token is 401", noauth.status === 401);
const foreign = await fetch(base, { method: "POST", headers: H({ origin: "https://evil.example" }), body: "{}" });
ok("foreign origin is 403", foreign.status === 403);

const p1 = await rpc("events/poll", { name: "fake.tick", cursor: null }, 3, { "mcp-name": "fake.tick" });
ok("first poll (null) starts from now, no events", p1.result?.events?.length === 0 && typeof p1.result.cursor === "string", p1);
await Bun.sleep(2300);
const p2 = await rpc("events/poll", { name: "fake.tick", cursor: p1.result.cursor }, 4, { "mcp-name": "fake.tick" });
const ids = (p2.result?.events ?? []).map((e: any) => e.eventId);
ok("second poll returns the ticks since, in order", ids.length >= 2 && ids.every((x: string, i: number) => i === 0 || Number(x.slice(5)) === Number(ids[i - 1].slice(5)) + 1), p2);
const p3 = await rpc("events/poll", { name: "fake.tick", cursor: p2.result.cursor }, 5, { "mcp-name": "fake.tick" });
ok("repeating with the new cursor gives no duplicates", !(p3.result?.events ?? []).some((e: any) => ids.includes(e.eventId)), p3);
const future = await rpc("events/poll", { name: "fake.tick", cursor: "99999" }, 6, { "mcp-name": "fake.tick" });
ok("a cursor from the future (server restarted) reports truncated", future.result?.truncated === true, future);

const ac = new AbortController();
const res = await fetch(base, { method: "POST", signal: ac.signal, headers: H({ "mcp-name": "fake.tick" }), body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "events/stream", params: { name: "fake.tick", arguments: {}, cursor: null, heartbeatMs: 1000 } }) });
ok("stream answers with text/event-stream", res.headers.get("content-type")?.startsWith("text/event-stream") === true);
const seen: string[] = []; let buf = ""; const dec = new TextDecoder();
const deadline = Date.now() + 3500;
try {
  for await (const chunk of res.body as any) {
    buf += dec.decode(chunk, { stream: true });
    let i; while ((i = buf.indexOf("\n\n")) >= 0) { const frame = buf.slice(0, i); buf = buf.slice(i + 2); if (frame.startsWith("data: ")) seen.push(JSON.parse(frame.slice(6))); }
    if (Date.now() > deadline) break;
  }
} catch {}
ac.abort();
const methods = seen.map((m: any) => m.method);
ok("stream: first frame is notifications/events/active with heartbeatMs", methods[0] === "notifications/events/active" && (seen[0] as any).params.heartbeatMs === 1000, seen[0]);
ok("stream: events arrive with cursor and subscriptionId", seen.some((m: any) => m.method === "notifications/events/event" && m.params.cursor && m.params._meta?.["io.modelcontextprotocol/subscriptionId"] === 7), seen);
ok("stream: a heartbeat carries a cursor", seen.some((m: any) => m.method === "notifications/events/heartbeat" && typeof m.params.cursor === "string"), methods);
s.stop(true);
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
