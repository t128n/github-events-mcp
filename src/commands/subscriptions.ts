import {
  addSubscription,
  describeSubscription,
  normalizeEvents,
  normalizeRepoPattern,
  readConfig,
  removeSubscription,
  saveConfig,
  type GithubEventName,
} from "../config/config.ts";
import { configPath } from "../config/home.ts";
import { booleanFlag, fail, listFlag, out, parseFlags, stringFlag } from "../cli.ts";
import { reloadDaemon, reloadNote } from "./reload.ts";

const SUBSCRIBE_FLAGS = {
  host: { type: "string", arg: "host", description: "GitHub host (default: the config's default host)" },
  events: { type: "string", arg: "a,b", description: "event types to watch (default: all)" },
  json: { type: "boolean", description: "print the subscription as JSON" },
} as const;

export async function subscribeCommand(args: string[], configFile = configPath()): Promise<number> {
  const parsed = parseFlags("subscribe", SUBSCRIBE_FLAGS, args);
  if (typeof parsed === "number") return parsed;
  const pattern = parsed.positionals[0];
  if (!pattern || parsed.positionals.length > 1) return fail("usage: subscribe <owner/repo|owner/*> [--host H] [--events a,b]");

  let config;
  try {
    config = readConfig(configFile);
  } catch (error) {
    return fail((error as Error).message);
  }
  if (!config) return fail("no config yet; run: github-events-mcp setup");

  const host = (stringFlag(parsed.values, "host", config.defaultHost) ?? config.defaultHost).toLowerCase();
  let events: GithubEventName[] | undefined;
  try {
    events = normalizeEvents(listFlag(parsed.values, "events"));
  } catch (error) {
    return fail((error as Error).message);
  }

  try {
    config = addSubscription(config, { host, repo: pattern, ...(events ? { events } : {}) });
    saveConfig(config, configFile);
  } catch (error) {
    return fail((error as Error).message);
  }

  const subscription = config.subscriptions.find((item) => item.host === host && item.repo === normalizeRepoPattern(pattern))!;
  if (booleanFlag(parsed.values, "json")) out(JSON.stringify(subscription, null, 2));
  else out(`Subscribed: ${describeSubscription(subscription)}`);
  const note = reloadNote(await reloadDaemon(config));
  if (note) out(note);
  return 0;
}

export async function unsubscribeCommand(args: string[], configFile = configPath()): Promise<number> {
  const parsed = parseFlags(
    "unsubscribe",
    { host: { type: "string", arg: "host", description: "GitHub host (default: the config's default host)" } },
    args,
  );
  if (typeof parsed === "number") return parsed;
  const pattern = parsed.positionals[0];
  if (!pattern || parsed.positionals.length > 1) return fail("usage: unsubscribe <owner/repo|owner/*> [--host H]");

  let config;
  try {
    config = readConfig(configFile);
  } catch (error) {
    return fail((error as Error).message);
  }
  if (!config) return fail("no config yet; run: github-events-mcp setup");
  const host = (stringFlag(parsed.values, "host", config.defaultHost) ?? config.defaultHost).toLowerCase();

  let removed: boolean;
  try {
    const result = removeSubscription(config, host, pattern);
    config = result.config;
    removed = result.removed;
    if (removed) saveConfig(config, configFile);
  } catch (error) {
    return fail((error as Error).message);
  }
  if (!removed) return fail(`not subscribed: ${host} ${pattern}`);
  out(`Unsubscribed: ${host} ${pattern}`);
  const note = reloadNote(await reloadDaemon(config));
  if (note) out(note);
  return 0;
}

export async function subscriptionsCommand(args: string[], configFile = configPath()): Promise<number> {
  const parsed = parseFlags("subscriptions", { json: { type: "boolean", description: "print JSON" } }, args);
  if (typeof parsed === "number") return parsed;
  if (parsed.positionals.length) return fail("subscriptions takes no arguments");

  let config;
  try {
    config = readConfig(configFile);
  } catch (error) {
    return fail((error as Error).message);
  }
  if (!config) return fail("no config yet; run: github-events-mcp setup");

  if (booleanFlag(parsed.values, "json")) {
    out(JSON.stringify(config.subscriptions, null, 2));
    return 0;
  }
  if (!config.subscriptions.length) {
    out("Nothing is watched. Add one with: github-events-mcp subscribe owner/repo");
    return 0;
  }
  out("HOST\tREPOSITORY\tEVENTS");
  for (const subscription of config.subscriptions) out(describeSubscription(subscription));
  return 0;
}
