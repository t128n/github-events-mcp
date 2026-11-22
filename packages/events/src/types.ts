/**
 * The small vocabulary of the events extension. This package knows nothing about any particular
 * upstream: an event type supplies one `poll` function and the package does the rest.
 */

export type DeliveryMode = "poll" | "push";

/** JSON Schema, as far as this package needs it: objects with typed properties. */
export type JsonSchema = Record<string, unknown>;

export interface EventOccurrence<Data = unknown> {
  /** Stable for the same thing happening once. Clients dedupe with it. */
  eventId: string;
  name: string;
  /** ISO-8601. */
  timestamp: string;
  /** Plain JSON. Keep it thin; details belong in tools or the shell. */
  data: Data;
  /** Push and webhook only; poll carries the cursor at the response level. */
  cursor?: string | null;
}

export interface PollError {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface EventPollResult {
  events: EventOccurrence[];
  /** Opaque to the client. `null` means the event type has no replay position. */
  cursor: string | null;
  hasMore: boolean;
  nextPollMs?: number;
  truncated?: boolean;
  /** Recoverable upstream problems. The poll loop reports them without ending the stream. */
  errors?: PollError[];
}

export interface PollContext {
  /** Aborted when the daemon or the subscription loop stops. */
  signal?: AbortSignal;
  /** The source should not return more than this many events. */
  maxEvents: number;
  now: number;
}

export interface EventDefinition<Args = Record<string, unknown>, Data = unknown> {
  name: string;
  description: string;
  delivery?: DeliveryMode[];
  inputSchema?: JsonSchema;
  payloadSchema?: JsonSchema;
  /**
   * Event types in the same group share one upstream loop. The loop's poll may return
   * occurrences with any name in the group. Defaults to the event name.
   */
  group?: string;
  /**
   * Share one loop across different subscription arguments. Each stream still filters with
   * `filter` and only receives its own event name. Defaults to false.
   */
  shared?: boolean;
  /** Narrow an occurrence for one subscription's arguments. */
  filter?: (event: EventOccurrence<Data>, args: Args) => boolean;
  poll: (cursor: string | null, args: Args, context: PollContext) => Promise<EventPollResult>;
}

export function defineEvent<Args = Record<string, unknown>, Data = unknown>(
  definition: EventDefinition<Args, Data>,
): EventDefinition<Args, Data> {
  return {
    delivery: ["poll", "push"],
    inputSchema: { type: "object", properties: {} },
    ...definition,
  };
}

/**
 * The descriptor that `events/list` returns. It is deliberately built from the definition
 * rather than from the poll function, so a descriptor can be serialised.
 */
export interface EventDescriptor {
  name: string;
  description: string;
  delivery: DeliveryMode[];
  inputSchema: JsonSchema;
  payloadSchema: JsonSchema;
}

export const descriptorOf = <Args, Data>(event: EventDefinition<Args, Data>): EventDescriptor => ({
  name: event.name,
  description: event.description,
  delivery: event.delivery ?? ["poll", "push"],
  inputSchema: event.inputSchema ?? { type: "object", properties: {} },
  payloadSchema: event.payloadSchema ?? { type: "object" },
});

export class EventsError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "EventsError";
  }
}

export const notFound = (kind: "event" | "subscription" = "event"): EventsError =>
  new EventsError(-32023, "NotFound", { kind });
export const invalidParams = (message: string): EventsError => new EventsError(-32602, "InvalidParams", { reason: message });
export const resourceExhausted = (limit: string, max: number): EventsError =>
  new EventsError(-32025, "ResourceExhausted", { limit, max });
