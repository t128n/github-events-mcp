import { configPath, readSecret, tokenPath } from "../config/home.ts";
import { readConfig } from "../config/config.ts";
import { booleanFlag, fail, out, parseFlags, stringFlag } from "../cli.ts";
import { startDaemon } from "../daemon/daemon.ts";
import { type SourceFactory } from "../daemon/source.ts";
import { createGithubSource } from "../github/source.ts";

const FLAGS = {
  port: { type: "string", arg: "port", description: "listen on this port instead of the config's" },
  token: { type: "string", arg: "token", description: "use this bearer token instead of the token file" },
  "no-watch": { type: "boolean", description: "do not reload when the config file changes" },
} as const;

export interface ServeOptions {
  factory?: SourceFactory;
  configFile?: string;
  tokenFile?: string;
  /** For tests: return instead of waiting for a signal. */
  wait?: boolean;
}

export async function serveCommand(args: string[], options: ServeOptions = {}): Promise<number> {
  const parsed = parseFlags("serve", FLAGS, args);
  if (typeof parsed === "number") return parsed;
  if (parsed.positionals.length) return fail("serve takes no arguments");

  const configFile = options.configFile ?? configPath();
  let config;
  try {
    config = readConfig(configFile);
  } catch (error) {
    return fail((error as Error).message);
  }
  if (!config) return fail(`no config at ${configFile}; run: github-events-mcp setup`);

  const token = stringFlag(parsed.values, "token") ?? readSecret(options.tokenFile ?? tokenPath());
  if (!token) return fail("no bearer token; run setup");
  const port = Number(stringFlag(parsed.values, "port", String(config.port)));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fail("port must be between 1 and 65535");

  let daemon;
  try {
    daemon = startDaemon({
      config: { ...config, port },
      token,
      factory: options.factory ?? ((config) => createGithubSource(config)),
      configFile,
      watchConfig: !booleanFlag(parsed.values, "no-watch"),
      log: (message) => out(message),
    });
  } catch (error) {
    return fail(`could not start the daemon: ${(error as Error).message}`);
  }

  out(`Listening on http://127.0.0.1:${daemon.port}/mcp`);
  out(`Health:    http://127.0.0.1:${daemon.port}/health`);
  if (!config.subscriptions.length) out("No subscriptions: nothing will be polled until you subscribe.");

  const shutdown = () => {
    daemon.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  if (options.wait === false) return 0;
  await new Promise<void>(() => {});
  return 0;
}
