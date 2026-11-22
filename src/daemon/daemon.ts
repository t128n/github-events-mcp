import { watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { EventHub, FileStateStore, startEventsServer, type RunningEventsServer } from "@github-events-mcp/events";
import { APP_DESCRIPTION } from "../cli.ts";
import { readConfig, validateConfig, type Config } from "../config/config.ts";
import { configPath, statePath } from "../config/home.ts";
import { VERSION } from "../version.ts";
import type { EventSource, SourceFactory } from "./source.ts";

export interface DaemonOptions {
  config: Config;
  token: string;
  factory: SourceFactory;
  configFile?: string;
  stateFile?: string;
  port?: number;
  watchConfig?: boolean;
  log?: (message: string) => void;
}

export interface RunningDaemon {
  port: number;
  reload(): Promise<void>;
  stop(): void;
  hub(): EventHub;
  config(): Config;
}

export function startDaemon(options: DaemonOptions): RunningDaemon {
  const log = options.log ?? ((message: string) => console.log(message));
  const configFile = options.configFile ?? configPath();
  const stateFile = options.stateFile ?? statePath();
  let config = options.config;
  let source = options.factory(config);
  let hub = makeHub(source, config, stateFile, log);
  let server: RunningEventsServer | undefined;
  let watcher: FSWatcher | undefined;
  let stopped = false;

  const handler = {
    getHub: () => hub,
    token: options.token,
    serverInfo: { name: APP_DESCRIPTION, version: VERSION },
    health: () => ({
      ...source.health?.(),
      lastPollAt: hub.status().lastPollAt,
      groups: hub.status().groups,
      subscriptions: config.subscriptions.length,
    }),
    reload: async () => {
      await reload();
    },
  };

  const requestedPort = options.port ?? config.port;
  server = startEventsServer({ ...handler, port: requestedPort });
  const boundPort = server.port;

  async function reload(): Promise<void> {
    if (stopped) return;
    let next: Config;
    try {
      const loaded = readConfig(configFile);
      if (!loaded) throw new Error(`no config at ${configFile}`);
      next = validateConfig(loaded);
    } catch (error) {
      log(`reload failed: ${(error as Error).message}`);
      throw error;
    }
    if (JSON.stringify(next) === JSON.stringify(config)) return;
    if (next.port !== boundPort) log(`config port ${next.port} differs from the running port ${boundPort}; restart to change it`);
    let nextSource: EventSource | undefined;
    let nextHub: EventHub | undefined;
    try {
      nextSource = options.factory(next);
      nextHub = makeHub(nextSource, next, stateFile, log);
    } catch (error) {
      nextHub?.close();
      nextSource?.close?.();
      log(`reload failed: ${(error as Error).message}`);
      throw error;
    }
    const previousHub = hub;
    const previousSource = source;
    hub = nextHub;
    source = nextSource;
    config = next;
    previousHub.close();
    previousSource.close?.();
    log(
      `reloaded config: ${config.subscriptions.length} subscription(s) on ${[...new Set(config.subscriptions.map((item) => item.host))].join(", ") || "no hosts"}`,
    );
  }

  if (options.watchConfig !== false) {
    try {
      watcher = watch(dirname(configFile), { persistent: false }, (_event, filename) => {
        const name = filename?.toString();
        if (name && name !== "config.json" && !name.startsWith("config.json.")) return;
        setTimeout(() => {
          void reload().catch(() => {
            // The failure is logged and a later change can succeed.
          });
        }, 200).unref?.();
      });
    } catch (error) {
      log(`could not watch the config file: ${(error as Error).message}`);
    }
  }

  return {
    port: boundPort,
    reload,
    stop() {
      if (stopped) return;
      stopped = true;
      watcher?.close();
      server?.stop(true);
      hub.close();
      source.close?.();
    },
    hub: () => hub,
    config: () => config,
  };
}

function makeHub(source: EventSource, config: Config, stateFile: string, log: (message: string) => void): EventHub {
  const hub = new EventHub({
    events: source.events,
    store: new FileStateStore(stateFile),
    serverInfo: { name: APP_DESCRIPTION, version: VERSION },
    log,
  });
  if (config.subscriptions.length) {
    for (const event of source.events) {
      try {
        // One keep-alive loop per group, even before a client streams: the daemon must not lose
        // events between client sessions.
        hub.ensure(event.name, {});
      } catch (error) {
        log(`could not start ${event.name}: ${(error as Error).message}`);
      }
    }
  }
  return hub;
}
