import { configPath, readJson, writeJson } from "./home.ts";

export const GITHUB_EVENT_NAMES = [
  "github.pr.review_requested",
  "github.pr.comment",
  "github.pr.ci_failed",
  "github.issue.assigned",
  "github.issue.comment",
  "github.mention",
] as const;

export type GithubEventName = (typeof GITHUB_EVENT_NAMES)[number];

export const DEFAULT_HOST = "github.com";

export interface Subscription {
  host: string;
  /** `owner/repo` or `owner/*`. */
  repo: string;
  /** Omitted or empty means every event type. */
  events?: GithubEventName[];
}

export interface Config {
  version: 1;
  port: number;
  hosts: string[];
  defaultHost: string;
  /** Never poll faster than this, whatever X-Poll-Interval says. */
  pollFloorSeconds: number;
  /** true sends `all=false` to the notifications API. */
  participatingOnly: boolean;
  subscriptions: Subscription[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const defaultConfig = (): Config => ({
  version: 1,
  port: 8765,
  hosts: [DEFAULT_HOST],
  defaultHost: DEFAULT_HOST,
  pollFloorSeconds: 60,
  participatingOnly: true,
  subscriptions: [],
});

export function readConfig(path = configPath()): Config | undefined {
  const value = readJson<unknown>(path);
  if (value === undefined) return undefined;
  return validateConfig(value);
}

export function saveConfig(config: Config, path = configPath()): void {
  writeJson(path, validateConfig(config));
}

export function validateConfig(value: unknown): Config {
  if (!isObject(value)) throw new ConfigError("config must be a JSON object");
  if (value.version !== 1) throw new ConfigError("config.version must be 1");
  const port = value.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("config.port must be an integer between 1 and 65535");
  }
  if (!Array.isArray(value.hosts) || value.hosts.length === 0) throw new ConfigError("config.hosts must be a non-empty array");
  const hosts = value.hosts.map((host) => {
    if (typeof host !== "string" || !hostname(host)) throw new ConfigError(`config.hosts has an invalid host: ${String(host)}`);
    return host.toLowerCase();
  });
  if (new Set(hosts).size !== hosts.length) throw new ConfigError("config.hosts contains a duplicate");
  if (typeof value.defaultHost !== "string" || !hosts.includes(value.defaultHost.toLowerCase())) {
    throw new ConfigError("config.defaultHost must be one of config.hosts");
  }
  const floor = value.pollFloorSeconds;
  if (typeof floor !== "number" || !Number.isInteger(floor) || floor < 10 || floor > 3600) {
    throw new ConfigError("config.pollFloorSeconds must be an integer between 10 and 3600");
  }
  if (typeof value.participatingOnly !== "boolean") throw new ConfigError("config.participatingOnly must be a boolean");
  if (!Array.isArray(value.subscriptions)) throw new ConfigError("config.subscriptions must be an array");

  const subscriptions: Subscription[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.subscriptions.entries()) {
    if (!isObject(raw)) throw new ConfigError(`config.subscriptions[${index}] must be an object`);
    if (typeof raw.host !== "string" || !hostname(raw.host)) throw new ConfigError(`config.subscriptions[${index}].host is invalid`);
    const host = raw.host.toLowerCase();
    if (!hosts.includes(host)) throw new ConfigError(`config.subscriptions[${index}].host is not in config.hosts`);
    if (typeof raw.repo !== "string") throw new ConfigError(`config.subscriptions[${index}].repo is invalid`);
    const repo = normalizeRepoPattern(raw.repo);
    const key = `${host}\u0000${repo}`;
    if (seen.has(key)) throw new ConfigError(`config.subscriptions has a duplicate for ${host} ${repo}`);
    seen.add(key);
    const events = normalizeEvents(raw.events, index);
    subscriptions.push({ host, repo, ...(events ? { events } : {}) });
  }
  return {
    version: 1,
    port,
    hosts,
    defaultHost: value.defaultHost.toLowerCase(),
    pollFloorSeconds: floor,
    participatingOnly: value.participatingOnly,
    subscriptions,
  };
}

export function normalizeRepoPattern(input: string): string {
  const value = input.trim();
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+|\*)$/.exec(value);
  if (!match) throw new ConfigError(`"${input}" is not owner/repo or owner/*`);
  return `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`;
}

export function normalizeEvents(value: unknown, index?: number): GithubEventName[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(list)) throw new ConfigError(`subscription events must be an array or a comma-separated string`);
  const names: GithubEventName[] = [];
  for (const item of list) {
    if (typeof item !== "string" || !isGithubEventName(item)) {
      throw new ConfigError(`unknown event type "${String(item)}"${index === undefined ? "" : ` in config.subscriptions[${index}]`}`);
    }
    if (!names.includes(item)) names.push(item);
  }
  return names.length ? names : undefined;
}

export const isGithubEventName = (value: string): value is GithubEventName =>
  (GITHUB_EVENT_NAMES as readonly string[]).includes(value);

export function addSubscription(config: Config, subscription: Subscription): Config {
  const next: Subscription = {
    host: subscription.host.toLowerCase(),
    repo: normalizeRepoPattern(subscription.repo),
    ...(subscription.events?.length ? { events: [...new Set(subscription.events)] } : {}),
  };
  if (!config.hosts.includes(next.host)) throw new ConfigError(`host ${next.host} is not configured; run setup first`);
  const subscriptions = config.subscriptions.filter((item) => !(item.host === next.host && item.repo === next.repo));
  subscriptions.push(next);
  subscriptions.sort((a, b) => `${a.host}/${a.repo}`.localeCompare(`${b.host}/${b.repo}`));
  return validateConfig({ ...config, subscriptions });
}

export function removeSubscription(config: Config, host: string, repo: string): { config: Config; removed: boolean } {
  const normalizedHost = host.toLowerCase();
  const normalizedRepo = normalizeRepoPattern(repo);
  const subscriptions = config.subscriptions.filter((item) => !(item.host === normalizedHost && item.repo === normalizedRepo));
  return {
    config: validateConfig({ ...config, subscriptions }),
    removed: subscriptions.length !== config.subscriptions.length,
  };
}

/** A notification only becomes an event when this returns true. */
export function subscriptionMatches(
  subscription: Subscription,
  host: string,
  repositoryFullName: string,
  eventName: string,
): boolean {
  if (subscription.host.toLowerCase() !== host.toLowerCase()) return false;
  const full = repositoryFullName.toLowerCase();
  const [owner, repo] = subscription.repo.split("/");
  if (!owner) return false;
  if (repo === "*") {
    if (!full.startsWith(`${owner}/`)) return false;
  } else if (full !== subscription.repo) {
    return false;
  }
  return !subscription.events?.length || (subscription.events as string[]).includes(eventName);
}

export function matchesAnySubscription(config: Config, host: string, repositoryFullName: string, eventName: string): boolean {
  return config.subscriptions.some((subscription) => subscriptionMatches(subscription, host, repositoryFullName, eventName));
}

/** Hosts that have at least one subscription. The daemon polls only these. */
export function subscribedHosts(config: Config): string[] {
  return [...new Set(config.subscriptions.map((subscription) => subscription.host))];
}

export function describeSubscription(subscription: Subscription): string {
  const events = subscription.events?.length ? subscription.events.join(",") : "all";
  return `${subscription.host}\t${subscription.repo}\t${events}`;
}

function hostname(value: string): boolean {
  return /^[a-z0-9][a-z0-9.-]*(?::\d{1,5})?$/i.test(value);
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
