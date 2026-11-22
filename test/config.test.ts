import { describe, expect, test } from "bun:test";
import {
  ConfigError,
  addSubscription,
  defaultConfig,
  matchesAnySubscription,
  normalizeEvents,
  normalizeRepoPattern,
  removeSubscription,
  subscriptionMatches,
  subscribedHosts,
  validateConfig,
  type Subscription,
} from "../src/config/config.ts";

describe("config validation", () => {
  test("the default config is valid", () => {
    expect(validateConfig(defaultConfig()).hosts).toEqual(["github.com"]);
  });

  test("rejects a bad port, host, floor and event", () => {
    expect(() => validateConfig({ ...defaultConfig(), port: 0 })).toThrow(ConfigError);
    expect(() => validateConfig({ ...defaultConfig(), hosts: [] })).toThrow(ConfigError);
    expect(() => validateConfig({ ...defaultConfig(), defaultHost: "other.example" })).toThrow(ConfigError);
    expect(() => validateConfig({ ...defaultConfig(), pollFloorSeconds: 1 })).toThrow(ConfigError);
    expect(() =>
      validateConfig({
        ...defaultConfig(),
        subscriptions: [{ host: "github.com", repo: "owner/repo", events: ["nope"] }],
      }),
    ).toThrow(ConfigError);
  });

  test("rejects a subscription on a host that is not configured", () => {
    expect(() =>
      validateConfig({
        ...defaultConfig(),
        subscriptions: [{ host: "github.example.com", repo: "owner/repo" }],
      }),
    ).toThrow(ConfigError);
  });

  test("accepts the created and CI event names", () => {
    expect(normalizeEvents(["github.issue.created", "github.pr.created", "github.ci.failed"])).toEqual([
      "github.issue.created",
      "github.pr.created",
      "github.ci.failed",
    ]);
  });

  test("accepts owner/* and normalises case", () => {
    expect(normalizeRepoPattern("Owner/*")).toBe("owner/*");
    expect(normalizeRepoPattern("Owner/Repo")).toBe("owner/repo");
    expect(() => normalizeRepoPattern("owner")).toThrow(ConfigError);
    expect(() => normalizeRepoPattern("owner/repo/extra")).toThrow(ConfigError);
  });

  test("adds, replaces and removes subscriptions", () => {
    let config = defaultConfig();
    config = addSubscription(config, { host: "github.com", repo: "owner/repo", events: ["github.mention"] });
    expect(config.subscriptions).toHaveLength(1);
    config = addSubscription(config, { host: "github.com", repo: "owner/repo", events: ["github.pr.comment"] });
    expect(config.subscriptions).toHaveLength(1);
    expect(config.subscriptions[0]!.events).toEqual(["github.pr.comment"]);
    const removed = removeSubscription(config, "github.com", "owner/repo");
    expect(removed.removed).toBe(true);
    expect(removed.config.subscriptions).toHaveLength(0);
    expect(removeSubscription(config, "github.com", "owner/other").removed).toBe(false);
  });
});

describe("subscription matcher", () => {
  const exact = { host: "github.com", repo: "owner/repo" };
  const wildcard: Subscription = { host: "github.com", repo: "owner/*", events: ["github.mention"] };

  test("matches an exact repository and a wildcard owner", () => {
    expect(subscriptionMatches(exact, "github.com", "owner/repo", "github.pr.comment")).toBe(true);
    expect(subscriptionMatches(exact, "github.com", "owner/other", "github.pr.comment")).toBe(false);
    expect(subscriptionMatches(wildcard, "github.com", "owner/anything", "github.mention")).toBe(true);
    expect(subscriptionMatches(wildcard, "github.com", "other/anything", "github.mention")).toBe(false);
  });

  test("respects the host and the event filter", () => {
    expect(subscriptionMatches(exact, "github.example.com", "owner/repo", "github.pr.comment")).toBe(false);
    expect(subscriptionMatches(wildcard, "github.com", "owner/anything", "github.pr.comment")).toBe(false);
    expect(matchesAnySubscription({ ...defaultConfig(), subscriptions: [wildcard] }, "github.com", "owner/anything", "github.mention")).toBe(true);
  });

  test("lists only hosts with subscriptions", () => {
    const config = {
      ...defaultConfig(),
      hosts: ["github.com", "github.example.com"],
      subscriptions: [
        { host: "github.com", repo: "a/b" },
        { host: "github.com", repo: "a/c" },
        { host: "github.example.com", repo: "a/d" },
      ],
    };
    expect(subscribedHosts(validateConfig(config))).toEqual(["github.com", "github.example.com"]);
  });
});
