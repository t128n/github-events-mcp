import { createHash } from "node:crypto";
import {
  EventsError,
  descriptorOf,
  notFound,
  resourceExhausted,
  type EventDefinition,
  type EventDescriptor,
  type EventOccurrence,
  type EventPollResult,
  type PollError,
} from "./types.ts";
import { MemoryStateStore, type StateStore, type StoredGroup, type StoredState } from "./store.ts";
import { validateArguments } from "./validate.ts";

export interface Limits {
  maxEventsPerPoll: number;
  maxPayloadBytes: number;
  maxGroups: number;
  maxPending: number;
  maxSeen: number;
  heartbeatMs: number;
  minPollMs: number;
  maxBackoffMs: number;
  maxPollMs: number;
}

export const defaultLimits: Limits = {
  maxEventsPerPoll: 50,
  maxPayloadBytes: 16 * 1024,
  maxGroups: 50,
  maxPending: 200,
  maxSeen: 1000,
  heartbeatMs: 15_000,
  minPollMs: 250,
  maxBackoffMs: 5 * 60_000,
  maxPollMs: 24 * 60 * 60_000,
};

export interface HubOptions {
  events: EventDefinition<any, any>[];
  store?: StateStore;
  limits?: Partial<Limits>;
  now?: () => number;
  log?: (message: string) => void;
  serverInfo: { name: string; version: string };
}

export interface StreamHandlers {
  onActive(info: { cursor: string | null; truncated: boolean; heartbeatMs: number }): void;
  onEvent(event: EventOccurrence): void;
  onHeartbeat(info: { cursor: string | null }): void;
  onError(error: PollError): void;
}

export interface StreamSubscription {
  close(): void;
  readonly heartbeatMs: number;
  readonly cursor: string | null;
  readonly truncated: boolean;
}

export interface GroupStatus {
  group: string;
  name: string;
  cursor: string | null;
  lastPollAt?: string;
  lastError?: { message: string; at: string };
  subscribers: number;
  pending: number;
  nextPollMs: number;
}

interface Subscriber {
  name: string;
  args: Record<string, unknown>;
  handlers: StreamHandlers;
  filter?: (event: EventOccurrence, args: Record<string, unknown>) => boolean;
}

export class EventHub {
  readonly limits: Limits;
  private readonly definitions: Map<string, EventDefinition<any, any>>;
  private readonly groups = new Map<string, GroupLoop>();
  private readonly store: StateStore;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private state: StoredState;
  private readonly serverInfo: { name: string; version: string };
  private closed = false;

  constructor(options: HubOptions) {
    this.limits = { ...defaultLimits, ...options.limits };
    this.definitions = new Map(options.events.map((event) => [event.name, event]));
    this.store = options.store ?? new MemoryStateStore();
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.serverInfo = options.serverInfo;
    this.state = this.store.load();
  }

  list(): EventDescriptor[] {
    return [...this.definitions.values()].map(descriptorOf);
  }

  definition(name: string): EventDefinition<any, any> | undefined {
    return this.definitions.get(name);
  }

  /** Stateless poll: the client owns the cursor and dedupes by eventId. */
  async poll(
    name: string,
    args: unknown,
    cursor: string | null,
    maxEvents: number | undefined,
  ): Promise<EventPollResult> {
    const definition = this.definitions.get(name);
    if (!definition) throw notFound("event");
    const cleanArgs = validateArguments(definition.inputSchema, args);
    const limit = clamp(Math.floor(maxEvents ?? this.limits.maxEventsPerPoll), 1, this.limits.maxEventsPerPoll);
    // Several event names can share an upstream group. Give the source room for each name,
    // then filter and cap to the requested name; otherwise one busy name can starve another.
    const groupName = definition.group ?? definition.name;
    const groupSize = Math.max(1, [...this.definitions.values()].filter((event) => (event.group ?? event.name) === groupName).length);
    const sourceLimit = limit * groupSize;
    const result = await definition.poll(cursor, cleanArgs, {
      maxEvents: sourceLimit,
      now: this.now(),
    });
    return this.cleanResult(definition, cleanArgs, result, limit);
  }

  /** Creates a group loop that polls even when no stream is attached (used by the daemon). */
  ensure(name: string, args: unknown = {}): void {
    const definition = this.definitions.get(name);
    if (!definition) throw notFound("event");
    this.ensureGroup(definition, validateArguments(definition.inputSchema, args), true);
  }

  openStream(
    name: string,
    args: unknown,
    cursor: string | null,
    requestedHeartbeatMs: number | undefined,
    handlers: StreamHandlers,
  ): StreamSubscription {
    const definition = this.definitions.get(name);
    if (!definition) throw notFound("event");
    const cleanArgs = validateArguments(definition.inputSchema, args);
    const group = this.ensureGroup(definition, cleanArgs, false);
    const heartbeatMs = clamp(
      Math.floor(requestedHeartbeatMs ?? this.limits.heartbeatMs),
      1_000,
      30_000,
    );
    const subscriber: Subscriber = {
      name,
      args: cleanArgs,
      handlers,
      filter: definition.filter ? (event, a) => definition.filter!(event, a) : undefined,
    };
    group.subscribe(subscriber, heartbeatMs, cursor);
    return {
      close: () => group.unsubscribe(subscriber),
      heartbeatMs,
      cursor: group.cursor,
      truncated: group.truncated,
    };
  }

  status(): { groups: GroupStatus[]; lastPollAt?: string; pending: number } {
    const groups = [...this.groups.values()].map((group) => group.status());
    const times = groups.map((group) => group.lastPollAt).filter((value): value is string => !!value).sort();
    return {
      groups,
      lastPollAt: times.length ? times[times.length - 1] : undefined,
      pending: groups.reduce((sum, group) => sum + group.pending, 0),
    };
  }

  close(): void {
    this.closed = true;
    for (const group of [...this.groups.values()]) group.stop();
    this.groups.clear();
  }

  private cleanResult(
    definition: EventDefinition<any, any>,
    args: Record<string, unknown>,
    result: EventPollResult,
    limit: number,
  ): EventPollResult {
    const events: EventOccurrence[] = [];
    let truncated = result.truncated === true;
    for (const event of result.events) {
      if (event.name !== definition.name) continue;
      if (definition.filter && !definition.filter(event, args)) continue;
      if (this.tooLarge(event)) {
        truncated = true; // a dropped event is a gap, and the client should refetch with tools
        continue;
      }
      events.push(stripCursor(event));
      if (events.length >= limit) {
        if (result.events.length > events.length) truncated = true;
        break;
      }
    }
    return {
      events,
      cursor: result.cursor,
      hasMore: result.hasMore && events.length >= limit,
      nextPollMs: result.nextPollMs,
      truncated,
      ...(result.errors?.length ? { errors: result.errors } : {}),
    };
  }

  private ensureGroup(definition: EventDefinition<any, any>, args: Record<string, unknown>, keepAlive: boolean): GroupLoop {
    if (this.closed) throw new Error("the event hub is closed");
    const groupName = definition.group ?? definition.name;
    const key = this.groupKey(groupName, args, definition.shared === true);
    let group = this.groups.get(key);
    if (group) {
      if (keepAlive) group.keepAlive = true;
      group.start();
      return group;
    }
    if (this.groups.size >= this.limits.maxGroups) throw resourceExhausted("subscriptions", this.limits.maxGroups);
    const definitions = [...this.definitions.values()].filter((event) => (event.group ?? event.name) === groupName);
    const poll = definitions[0]!.poll;
    const saved = this.state.groups[key];
    group = new GroupLoop({
      key,
      group: groupName,
      definitions,
      args,
      poll,
      saved,
      keepAlive,
      limits: this.limits,
      now: this.now,
      log: this.log,
      persist: () => this.persist(),
      onStop: (stoppedKey) => this.groups.delete(stoppedKey),
    });
    this.groups.set(key, group);
    if (!saved) this.state.groups[key] = group.snapshot();
    group.start();
    return group;
  }

  private groupKey(group: string, args: Record<string, unknown>, shared: boolean): string {
    const raw = shared ? `group:${group}` : `group:${group}\u0000${stableStringify(args)}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 24);
  }

  private persist(): void {
    for (const group of this.groups.values()) this.state.groups[group.key] = group.snapshot();
    try {
      this.store.save(this.state);
    } catch (error) {
      this.log(`could not save event state: ${(error as Error).message}`);
    }
  }

  private tooLarge(event: EventOccurrence): boolean {
    let text: string;
    try {
      text = JSON.stringify(event.data ?? null);
    } catch {
      return true;
    }
    return Buffer.byteLength(text, "utf8") > this.limits.maxPayloadBytes;
  }
}

interface GroupLoopOptions {
  key: string;
  group: string;
  definitions: EventDefinition<any, any>[];
  args: Record<string, unknown>;
  poll: EventDefinition<any, any>["poll"];
  saved?: StoredGroup;
  keepAlive: boolean;
  limits: Limits;
  now: () => number;
  log: (message: string) => void;
  persist: () => void;
  onStop: (key: string) => void;
}

class GroupLoop {
  readonly key: string;
  readonly group: string;
  readonly definitions: Map<string, EventDefinition<any, any>>;
  readonly args: Record<string, unknown>;
  keepAlive: boolean;
  cursor: string | null;
  truncated: boolean;
  private pending: EventOccurrence[];
  private seen: string[];
  private lastPollAt: string | undefined;
  private lastError: { message: string; at: string } | undefined;
  private readonly subscribers = new Set<Subscriber>();
  private readonly pollFunction: EventDefinition<any, any>["poll"];
  private readonly limits: Limits;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly persist: () => void;
  private readonly onStop: (key: string) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private controller: AbortController | undefined;
  private running = false;
  private stopped = false;
  private backoffMs = 0;
  private nextPollMs = 60_000;
  private heartbeatMs = 15_000;

  constructor(options: GroupLoopOptions) {
    this.key = options.key;
    this.group = options.group;
    this.definitions = new Map(options.definitions.map((event) => [event.name, event]));
    this.args = options.args;
    this.pollFunction = options.poll;
    this.keepAlive = options.keepAlive;
    this.limits = options.limits;
    this.now = options.now;
    this.log = options.log;
    this.persist = options.persist;
    this.onStop = options.onStop;
    this.cursor = options.saved?.cursor ?? null;
    this.truncated = options.saved?.truncated ?? false;
    this.pending = options.saved?.pending ?? [];
    this.seen = options.saved?.seen ?? [];
    this.lastPollAt = options.saved?.lastPollAt;
    this.lastError = options.saved?.lastError;
  }

  start(): void {
    if (this.stopped || this.timer || this.heartbeat) return;
    this.heartbeat = setInterval(() => this.sendHeartbeat(), this.heartbeatMs);
    this.schedule(0);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = undefined;
    this.heartbeat = undefined;
    this.controller?.abort();
    this.subscribers.clear();
    this.onStop(this.key);
  }

  subscribe(subscriber: Subscriber, heartbeatMs: number, clientCursor: string | null): void {
    this.heartbeatMs = heartbeatMs;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => this.sendHeartbeat(), this.heartbeatMs);
    this.subscribers.add(subscriber);
    subscriber.handlers.onActive({ cursor: this.cursor ?? clientCursor, truncated: this.truncated, heartbeatMs: this.heartbeatMs });
    this.flushPending(subscriber);
    this.start();
  }

  unsubscribe(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber);
    if (this.subscribers.size === 0 && !this.keepAlive) this.stop();
  }

  status(): GroupStatus {
    return {
      group: this.group,
      name: [...this.definitions.keys()][0] ?? this.group,
      cursor: this.cursor,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      subscribers: this.subscribers.size,
      pending: this.pending.length,
      nextPollMs: this.nextPollMs,
    };
  }

  snapshot(): StoredGroup {
    return {
      key: this.key,
      name: [...this.definitions.keys()][0] ?? this.group,
      group: this.group,
      arguments: this.args,
      cursor: this.cursor,
      pending: this.pending,
      seen: this.seen,
      truncated: this.truncated,
      updatedAt: new Date(this.now()).toISOString(),
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
    };
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = ms <= 0 ? 0 : clamp(Math.floor(ms), this.limits.minPollMs, this.limits.maxPollMs);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    this.controller = new AbortController();
    try {
      const result = await this.pollFunction(this.cursor, this.args, {
        signal: this.controller.signal,
        maxEvents: this.limits.maxEventsPerPoll,
        now: this.now(),
      });
      if (!this.stopped) this.handleResult(result);
    } catch (error) {
      if (!this.stopped && !this.controller.signal.aborted) this.handleError(error);
    } finally {
      this.running = false;
      this.controller = undefined;
    }
  }

  private handleResult(result: EventPollResult): void {
    this.backoffMs = 0;
    this.cursor = result.cursor;
    this.lastPollAt = new Date(this.now()).toISOString();
    this.lastError = undefined;
    this.nextPollMs = clamp(
      Math.floor(result.nextPollMs ?? 60_000),
      this.limits.minPollMs,
      this.limits.maxPollMs,
    );
    if (result.truncated) this.truncated = true;

    // A shared group may carry several event names. Cap per name instead of letting a busy
    // name crowd out the others in the same poll result.
    const capped = capPerName(result.events, this.limits.maxEventsPerPoll);
    let dropped = capped.dropped;
    for (const event of capped.events) {
      if (!this.definitions.has(event.name)) {
        this.log(`ignoring event ${event.name}: not in group ${this.group}`);
        continue;
      }
      if (this.seen.includes(event.eventId)) continue;
      if (this.tooLarge(event)) {
        this.log(`dropping oversized event ${event.name} (${event.eventId})`);
        dropped = true;
        continue;
      }
      this.remember(event.eventId);
      if (!this.deliver(event)) this.pushPending(event);
    }
    if (dropped) this.truncated = true;
    this.flushPending();
    if (result.errors?.length) for (const error of result.errors) this.broadcastError(error);
    if (this.truncated) {
      this.broadcastActive();
      this.truncated = false;
    }
    this.persist();
    this.schedule(result.hasMore ? 0 : this.nextPollMs);
  }

  private handleError(error: unknown): void {
    const pollError = toPollError(error);
    const at = new Date(this.now()).toISOString();
    this.lastError = { message: pollError.message, at };
    this.broadcastError(pollError);
    const retryAfter = (error as { retryAfterMs?: unknown })?.retryAfterMs;
    const base = typeof retryAfter === "number" && retryAfter > 0 ? retryAfter : undefined;
    this.backoffMs = base ?? (this.backoffMs ? Math.min(this.backoffMs * 2, this.limits.maxBackoffMs) : Math.min(1_000, this.limits.maxBackoffMs));
    this.persist();
    this.schedule(this.backoffMs);
  }

  private deliver(event: EventOccurrence): boolean {
    let delivered = false;
    for (const subscriber of this.subscribers) {
      if (!this.matches(subscriber, event)) continue;
      subscriber.handlers.onEvent(stripCursor(event));
      delivered = true;
    }
    return delivered;
  }

  private pushPending(event: EventOccurrence): void {
    if (this.pending.some((queued) => queued.eventId === event.eventId)) return;
    this.pending.push(event);
    if (this.pending.length > this.limits.maxPending) {
      this.pending.shift();
      this.truncated = true;
    }
  }

  private flushPending(only?: Subscriber): void {
    if (!this.pending.length || !this.subscribers.size) return;
    const keep: EventOccurrence[] = [];
    let changed = false;
    for (const event of this.pending) {
      let delivered = false;
      const targets = only ? [only] : [...this.subscribers];
      for (const subscriber of targets) {
        if (!this.subscribers.has(subscriber)) continue;
        if (!this.matches(subscriber, event)) continue;
        subscriber.handlers.onEvent(stripCursor(event));
        delivered = true;
      }
      if (delivered && !only) changed = true;
      else if (!delivered) keep.push(event);
    }
    if (!only && changed) this.pending = keep;
    else if (only) this.pending = keep;
  }

  private matches(subscriber: Subscriber, event: EventOccurrence): boolean {
    if (subscriber.name !== event.name) return false;
    return subscriber.filter ? subscriber.filter(event, subscriber.args) : true;
  }

  private remember(eventId: string): void {
    this.seen.push(eventId);
    if (this.seen.length > this.limits.maxSeen) this.seen.splice(0, this.seen.length - this.limits.maxSeen);
  }

  private sendHeartbeat(): void {
    for (const subscriber of this.subscribers) subscriber.handlers.onHeartbeat({ cursor: this.cursor });
  }

  private broadcastActive(): void {
    for (const subscriber of this.subscribers) {
      subscriber.handlers.onActive({ cursor: this.cursor, truncated: true, heartbeatMs: this.heartbeatMs });
    }
  }

  private broadcastError(error: PollError): void {
    for (const subscriber of this.subscribers) subscriber.handlers.onError(error);
  }

  private tooLarge(event: EventOccurrence): boolean {
    try {
      return Buffer.byteLength(JSON.stringify(event.data ?? null), "utf8") > this.limits.maxPayloadBytes;
    } catch {
      return true;
    }
  }
}

export function toPollError(error: unknown): PollError {
  if (error instanceof EventsError) {
    return { code: error.code, message: error.message, data: error.data };
  }
  if (error instanceof Error) return { code: -32603, message: "InternalError", data: { reason: error.message } };
  return { code: -32603, message: "InternalError", data: { reason: String(error) } };
}

function stripCursor(event: EventOccurrence): EventOccurrence {
  const { cursor: _cursor, ...rest } = event;
  return rest;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Keep the newest `limit` occurrences of each event name. */
export function capPerName(events: EventOccurrence[], limit: number): { events: EventOccurrence[]; dropped: boolean } {
  const groups = new Map<string, EventOccurrence[]>();
  for (const event of events) {
    const list = groups.get(event.name);
    if (list) list.push(event);
    else groups.set(event.name, [event]);
  }
  let dropped = false;
  const kept: EventOccurrence[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => (a.timestamp === b.timestamp ? a.eventId.localeCompare(b.eventId) : a.timestamp.localeCompare(b.timestamp)));
    if (list.length > limit) dropped = true;
    kept.push(...list.slice(-limit));
  }
  return { events: kept, dropped };
}
