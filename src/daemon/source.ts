import type { EventDefinition } from "@github-events-mcp/events";
import type { Config } from "../config/config.ts";

/** The GitHub poller supplies event definitions; the daemon only wires them to the protocol. */
export interface EventSource {
  events: EventDefinition<any, any>[];
  /** Extra `/health` fields. Never include a token or a payload. */
  health?: () => Record<string, unknown>;
  close?: () => void;
}

export type SourceFactory = (config: Config) => EventSource;

/** Before the GitHub poller exists, `serve` has nothing to watch. */
export const emptySource: SourceFactory = () => ({
  events: [],
  health: () => ({ source: "none" }),
});
