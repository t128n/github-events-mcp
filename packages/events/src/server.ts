import { createHash, timingSafeEqual } from "node:crypto";
import type { EventHub, StreamHandlers } from "./hub.ts";
import type { EventOccurrence, PollError } from "./types.ts";
import { EventsError } from "./types.ts";

export const PROTOCOL_VERSION = "2026-07-28";
export const EVENTS_EXTENSION = "io.modelcontextprotocol/events";
export const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface EventsServerOptions {
  getHub: () => EventHub;
  token: string;
  serverInfo: { name: string; version: string };
  /** Extra fields for `/health`. Must not contain secrets. */
  health?: () => Record<string, unknown>;
  /** Called by an authenticated `POST /admin/reload`, before the response. */
  reload?: () => Promise<void> | void;
}

export type FetchHandler = (request: Request) => Promise<Response> | Response;

export function createEventsHandler(options: EventsServerOptions): FetchHandler {
  return async (request) => {
    const denied = checkRequestOrigin(request);
    if (denied) return denied;
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        status: "ok",
        name: options.serverInfo.name,
        version: options.serverInfo.version,
        protocol: PROTOCOL_VERSION,
        ...options.health?.(),
      });
    }

    if (!authorized(request, options.token)) return json({ error: "unauthorized" }, 401);

    if (url.pathname === "/admin/reload") {
      if (request.method !== "POST") return methodNotAllowed();
      try {
        await options.reload?.();
        return json({ ok: true });
      } catch (error) {
        return json({ error: (error as Error).message }, 500);
      }
    }

    if (url.pathname !== "/mcp") return json({ error: "not found" }, 404);
    if (request.method !== "POST") return methodNotAllowed();

    let message: RpcMessage;
    try {
      message = (await request.json()) as RpcMessage;
    } catch {
      return json(rpcError(null, -32700, "ParseError"), 400);
    }
    if (!message || typeof message !== "object" || typeof message.method !== "string") {
      return json(rpcError(null, -32600, "InvalidRequest"), 400);
    }
    if (message.id === undefined || message.id === null) return new Response(null, { status: 202 });

    const { id, method, params = {} } = message;
    if (!isObject(params)) return json(rpcError(id, -32602, "InvalidParams", { reason: "params must be an object" }), 400);

    if (method === "events/poll" || method === "events/stream") {
      const header = request.headers.get("mcp-name");
      if (header !== params.name) {
        return json(rpcError(id, -32020, "HeaderMismatch", { header: "Mcp-Name" }), 400);
      }
    }

    try {
      switch (method) {
        case "server/discover":
          return json(
            rpcResult(id, {
              supportedVersions: [PROTOCOL_VERSION],
              capabilities: { extensions: { [EVENTS_EXTENSION]: {} } },
              serverInfo: options.serverInfo,
              _meta: { "io.modelcontextprotocol/serverInfo": options.serverInfo },
            }),
          );
        case "initialize":
          return json(
            rpcResult(id, {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { extensions: { [EVENTS_EXTENSION]: {} } },
              serverInfo: options.serverInfo,
            }),
          );
        case "ping":
          return json(rpcResult(id, {}));
        case "events/list":
          return json(rpcResult(id, { events: options.getHub().list() }));
        case "events/poll":
          return await poll(options.getHub(), id, params);
        case "events/stream":
          return stream(options.getHub(), id, params, request.signal);
        default:
          return json(rpcError(id, -32601, "MethodNotFound"));
      }
    } catch (error) {
      return json(rpcErrorFrom(id, error), error instanceof EventsError ? 200 : 500);
    }
  };
}

export interface RunningEventsServer {
  port: number;
  stop(force?: boolean): void;
}

export function startEventsServer(options: EventsServerOptions & { port: number; hostname?: string }): RunningEventsServer {
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    idleTimeout: 0, // SSE streams must not time out
    fetch: createEventsHandler(options),
  });
  return { port: server.port ?? options.port, stop: (force?: boolean) => server.stop(force) };
}

async function poll(hub: EventHub, id: RpcId, params: Record<string, unknown>): Promise<Response> {
  const name = params.name;
  if (typeof name !== "string" || !name) return json(rpcError(id, -32602, "InvalidParams", { reason: "name is required" }), 400);
  const maxEvents = params.maxEvents;
  if (maxEvents !== undefined && (typeof maxEvents !== "number" || !Number.isInteger(maxEvents) || maxEvents < 1)) {
    return json(rpcError(id, -32602, "InvalidParams", { reason: "maxEvents must be a positive integer" }), 400);
  }
  const result = await hub.poll(
    name,
    params.arguments,
    typeof params.cursor === "string" ? params.cursor : null,
    maxEvents as number | undefined,
  );
  return json(
    rpcResult(id, {
      events: result.events,
      cursor: result.cursor,
      truncated: result.truncated === true,
      hasMore: result.hasMore,
      ...(result.nextPollMs !== undefined ? { nextPollMs: result.nextPollMs } : {}),
    }),
  );
}

function stream(hub: EventHub, id: RpcId, params: Record<string, unknown>, signal: AbortSignal): Response {
  const name = params.name;
  if (typeof name !== "string" || !name) return json(rpcError(id, -32602, "InvalidParams", { reason: "name is required" }), 400);

  const buffered: string[] = [];
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const send = (message: unknown): void => {
    const frame = `data: ${JSON.stringify(message)}\n\n`;
    if (controllerRef) {
      try {
        controllerRef.enqueue(encoder.encode(frame));
      } catch {
        closed = true;
      }
    } else {
      buffered.push(frame);
    }
  };
  const note = (type: string, body: Record<string, unknown>): void => {
    send({ jsonrpc: "2.0", method: `notifications/events/${type}`, params: { ...body, _meta: { [SUBSCRIPTION_ID]: id } } });
  };
  const handlers: StreamHandlers = {
    onActive: (info) => note("active", { cursor: info.cursor, truncated: info.truncated, heartbeatMs: info.heartbeatMs }),
    onEvent: (event) => note("event", { ...event }),
    onHeartbeat: (info) => note("heartbeat", { cursor: info.cursor }),
    onError: (error) => note("error", { error }),
  };

  let subscription: ReturnType<EventHub["openStream"]>;
  try {
    subscription = hub.openStream(
      name,
      params.arguments,
      typeof params.cursor === "string" ? params.cursor : null,
      typeof params.heartbeatMs === "number" ? params.heartbeatMs : undefined,
      handlers,
    );
  } catch (error) {
    return json(rpcErrorFrom(id, error), error instanceof EventsError ? 200 : 500);
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      const flush = (): void => {
        if (closed) return;
        while (buffered.length) controller.enqueue(encoder.encode(buffered.shift()!));
      };
      flush();
      signal.addEventListener(
        "abort",
        () => {
          if (closed) return;
          closed = true;
          subscription.close();
          try {
            controller.close();
          } catch {
            // already closed by the client
          }
        },
        { once: true },
      );
    },
    cancel() {
      closed = true;
      subscription.close();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

type RpcId = string | number | null;
interface RpcMessage {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: unknown;
}

export function rpcResult(id: RpcId, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result: { resultType: "complete", ...result } };
}

export function rpcError(id: RpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function rpcErrorFrom(id: RpcId, error: unknown): Record<string, unknown> {
  if (error instanceof EventsError) return rpcError(id, error.code, error.message, error.data);
  return rpcError(id, -32603, "InternalError", { reason: error instanceof Error ? error.message : String(error) });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8", allow: "GET, POST" },
  });
}

function authorized(request: Request, token: string): boolean {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return safeEqual(header.slice(7), token);
}

export function safeEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Loopback-only daemon: reject a foreign `Host` (DNS rebinding) and a foreign `Origin`. A
 * missing Host is allowed because HTTP/1.0 clients may omit it; a missing Origin is normal
 * for non-browser clients.
 */
export function checkRequestOrigin(request: Request): Response | null {
  const hostHeader = request.headers.get("host");
  if (hostHeader && !isLoopbackHost(hostHeader)) return json({ error: "forbidden host" }, 403);
  const origin = request.headers.get("origin");
  if (origin) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return json({ error: "forbidden origin" }, 403);
    }
    if (!isLoopbackHost(parsed.host) || !["http:", "https:"].includes(parsed.protocol)) {
      return json({ error: "forbidden origin" }, 403);
    }
  }
  return null;
}

function isLoopbackHost(value: string): boolean {
  const host = value.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end > 0 && LOOPBACK.has(host.slice(0, end + 1));
  }
  const withoutPort = host.split(":")[0] ?? host;
  return LOOPBACK.has(withoutPort);
}

/** A one-line, non-secret fingerprint for logs. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { EventOccurrence, PollError };
