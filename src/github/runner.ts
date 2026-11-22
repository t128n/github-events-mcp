import { parseHttpExchange } from "../platform/httpText.ts";
import { processRunner, type ProcessRunner } from "../platform/process.ts";

export interface GhResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  stderr: string;
  exitCode: number;
}

export interface GhRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * The poller talks to GitHub only through this interface. Tests use a fake with recorded
 * fixtures, so no test needs a login or a real notification.
 */
export interface GhRunner {
  run(args: string[], options?: GhRunOptions): Promise<GhResponse>;
}

/** `gh api -i ...`, parsed. Never logs a body or a token. */
export class ProcessGhRunner implements GhRunner {
  constructor(private readonly runner: ProcessRunner = processRunner) {}

  async run(args: string[], options: GhRunOptions = {}): Promise<GhResponse> {
    const result = await this.runner.run(["gh", ...args], options);
    const exchange = parseHttpExchange(result.stdout);
    return {
      status: exchange.status,
      headers: exchange.headers,
      body: exchange.body,
      stderr: result.stderr,
      exitCode: result.code,
    };
  }
}

export class GhAuthError extends Error {
  constructor(readonly host: string, detail: string) {
    super(`authentication failed for ${host}${detail ? `: ${detail}` : ""}`);
    this.name = "GhAuthError";
  }
}

export class GhRateLimitError extends Error {
  constructor(
    readonly host: string,
    readonly retryAfterMs: number,
    detail: string,
  ) {
    super(`rate limited by ${host}${detail ? `: ${detail}` : ""}`);
    this.name = "GhRateLimitError";
  }
}

export class GhHttpError extends Error {
  constructor(
    readonly host: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${host} returned HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "GhHttpError";
  }
}

export function header(response: GhResponse, name: string): string | undefined {
  return response.headers[name.toLowerCase()];
}

export function headerNumber(response: GhResponse, name: string): number | undefined {
  const value = header(response, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `Retry-After` is either seconds or an HTTP date. */
export function retryAfterMs(response: GhResponse, now = Date.now()): number | undefined {
  const value = header(response, "retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}
