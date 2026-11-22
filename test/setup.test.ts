import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup } from "../src/commands/setup.ts";
import { FakeProcessRunner } from "../src/platform/process.ts";
import { readConfig } from "../src/config/config.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "github-events-setup-"));
  dirs.push(dir);
  return dir;
}

const runner = () =>
  new FakeProcessRunner((command) => {
    if (command.join(" ") === "gh auth status --json hosts") {
      return {
        code: 0,
        stdout: JSON.stringify({
          hosts: {
            "github.com": [{ state: "success", active: true, host: "github.com", login: "octocat", scopes: "repo" }],
            "github.example.com": [{ state: "success", active: true, host: "github.example.com", login: "octocat" }],
          },
        }),
        stderr: "",
      };
    }
    return { code: 1, stdout: "", stderr: "unexpected command" };
  });

describe("setup", () => {
  test("writes a config and a user-only token and prints an MCP snippet", async () => {
    const dir = temp();
    const configFile = join(dir, "config.json");
    const tokenFile = join(dir, "token");
    const code = await runSetup(
      {
        host: ["github.com"],
        port: "0",
        "poll-floor": "60",
        subscribe: ["Owner/Repo"],
        events: ["github.mention"],
      },
      [],
      { runner: runner(), interactive: false, configFile, tokenFile },
    );
    expect(code).toBe(0);
    const config = readConfig(configFile)!;
    expect(config.hosts).toEqual(["github.com"]);
    expect(config.defaultHost).toBe("github.com");
    expect(config.port).toBeGreaterThan(0);
    expect(config.subscriptions[0]!.repo).toBe("owner/repo");
    expect(config.subscriptions[0]!.events).toEqual(["github.mention"]);
    expect(readFileSync(tokenFile, "utf8").length).toBeGreaterThan(20);
    if (process.platform !== "win32") {
      expect(statSync(configFile).mode & 0o077).toBe(0);
      expect(statSync(tokenFile).mode & 0o077).toBe(0);
    }
  });

  test("keeps subscriptions and the token on a second run", async () => {
    const dir = temp();
    const configFile = join(dir, "config.json");
    const tokenFile = join(dir, "token");
    const options = { runner: runner(), interactive: false, configFile, tokenFile };
    expect(await runSetup({ host: ["github.com"], port: "0", subscribe: ["a/b"] }, [], options)).toBe(0);
    const first = readFileSync(tokenFile, "utf8");
    const firstConfig = readConfig(configFile)!;
    expect(await runSetup({ port: String(firstConfig.port), "poll-floor": "90" }, [], options)).toBe(0);
    const secondConfig = readConfig(configFile)!;
    expect(secondConfig.pollFloorSeconds).toBe(90);
    expect(secondConfig.subscriptions).toHaveLength(1);
    expect(readFileSync(tokenFile, "utf8")).toBe(first);
  });

  test("uses the default host when no flag is given", async () => {
    const dir = temp();
    const code = await runSetup({ port: "0" }, [], {
      runner: runner(),
      interactive: false,
      configFile: join(dir, "config.json"),
      tokenFile: join(dir, "token"),
    });
    expect(code).toBe(0);
    expect(readConfig(join(dir, "config.json"))!.hosts).toEqual(["github.com"]);
  });

  test("fails clearly when gh is not signed in", async () => {
    const dir = temp();
    const code = await runSetup({ port: "0" }, [], {
      runner: new FakeProcessRunner(() => ({ code: 1, stdout: "", stderr: "not logged in" })),
      interactive: false,
      configFile: join(dir, "config.json"),
      tokenFile: join(dir, "token"),
    });
    expect(code).toBe(1);
  });
});
