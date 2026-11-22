/** A tiny process runner, so commands can be tested without touching the machine. */
export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface ProcessRunner {
  run(command: string[], options?: RunOptions): Promise<ProcessResult>;
}

export class BunProcessRunner implements ProcessRunner {
  async run(command: string[], options: RunOptions = {}): Promise<ProcessResult> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const child = Bun.spawn(command, {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        windowsHide: true,
        signal: controller.signal,
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { code: code ?? 1, stdout, stderr };
    } catch (error) {
      const message = (error as Error).message;
      if (controller.signal.aborted) return { code: 124, stdout: "", stderr: `timed out after ${timeoutMs} ms` };
      return { code: 1, stdout: "", stderr: message };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export const processRunner = new BunProcessRunner();

/** Tests use this for `gh`, `schtasks` and a version probe. */
export class FakeProcessRunner implements ProcessRunner {
  readonly calls: string[][] = [];
  constructor(private readonly handler: (command: string[], options?: RunOptions) => ProcessResult | Promise<ProcessResult>) {}

  async run(command: string[], options?: RunOptions): Promise<ProcessResult> {
    this.calls.push(command);
    return this.handler(command, options);
  }
}
