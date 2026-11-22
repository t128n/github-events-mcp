import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/commands/doctor.ts";
import { defaultConfig, saveConfig } from "../src/config/config.ts";
import { FakeProcessRunner } from "../src/platform/process.ts";
import { FakeScheduler } from "../src/platform/scheduler.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "github-events-doctor-"));
  dirs.push(dir);
  return dir;
}

const hostsJson = JSON.stringify({
  hosts: {
    "github.com": [{ state: "success", active: true, host: "github.com", login: "octocat", scopes: "repo" }],
  },
});

function runnerWith(notificationStatus = 200): FakeProcessRunner {
  return new FakeProcessRunner((command) => {
    const line = command.join(" ");
    if (line === "gh --version") return { code: 0, stdout: "gh version 2.101.0 (2026-01-01)\n", stderr: "" };
    if (line === "gh auth status --json hosts") return { code: 0, stdout: hostsJson, stderr: "" };
    if (line.startsWith("gh api -i --hostname github.com ")) {
      const headers =
        notificationStatus === 200
          ? "HTTP/2.0 200 OK\r\nX-Oauth-Scopes: repo\r\nX-Ratelimit-Remaining: 4999\r\nX-Poll-Interval: 60\r\n\r\n[]"
          : "HTTP/2.0 401 Unauthorized\r\n\r\n{}";
      return { code: notificationStatus === 200 ? 0 : 1, stdout: headers, stderr: notificationStatus === 200 ? "" : "gh: HTTP 401" };
    }
    return { code: 1, stdout: "", stderr: `unexpected command: ${line}` };
  });
}

function setupFiles() {
  const dir = temp();
  const configFile = join(dir, "config.json");
  const tokenFile = join(dir, "token");
  saveConfig({ ...defaultConfig(), port: 8799 }, configFile);
  writeFileSync(tokenFile, "a-test-token", { mode: 0o600 });
  return { dir, configFile, tokenFile };
}

describe("doctor", () => {
  test("passes every check with a working gh, token, task and daemon", async () => {
    const { configFile, tokenFile } = setupFiles();
    const scheduler = new FakeScheduler();
    scheduler.installed = true;
    const checks = await runDoctor({
      runner: runnerWith(),
      scheduler,
      configFile,
      tokenFile,
      fetchHealth: async () => ({ ok: true, body: {} }),
    });
    expect(checks.filter((check) => check.level === "fail")).toEqual([]);
    expect(checks.some((check) => check.name === "notifications github.com" && check.level === "pass")).toBe(true);
    expect(checks.some((check) => check.name === "logon task" && check.level === "pass")).toBe(true);
  });

  test("reports an auth failure on the notifications call", async () => {
    const { configFile, tokenFile } = setupFiles();
    const checks = await runDoctor({
      runner: runnerWith(401),
      scheduler: new FakeScheduler(),
      configFile,
      tokenFile,
      fetchHealth: async () => ({ ok: false }),
    });
    expect(checks.some((check) => check.name === "notifications github.com" && check.level === "fail")).toBe(true);
    expect(checks.some((check) => check.level === "fail" && check.fix?.includes("gh auth login"))).toBe(true);
  });

  test("reports a missing task and a missing daemon", async () => {
    const { configFile, tokenFile } = setupFiles();
    const checks = await runDoctor({
      runner: runnerWith(),
      scheduler: new FakeScheduler(),
      configFile,
      tokenFile,
      fetchHealth: async () => ({ ok: false }),
    });
    expect(checks.some((check) => check.name === "logon task" && check.level === "fail")).toBe(true);
    expect(checks.some((check) => check.name === "health" && check.level === "fail")).toBe(true);
  });

  test("reports a token that other users can read", async () => {
    const { configFile, tokenFile } = setupFiles();
    if (process.platform === "win32") return;
    writeFileSync(tokenFile, "a-test-token", { mode: 0o644 });
    chmodSync(tokenFile, 0o644);
    const checks = await runDoctor({
      runner: runnerWith(),
      scheduler: new FakeScheduler(),
      configFile,
      tokenFile,
      fetchHealth: async () => ({ ok: true }),
    });
    expect(checks.some((check) => check.name === "token permission" && check.level === "fail")).toBe(true);
  });

  test("reports a missing config", async () => {
    const dir = temp();
    const checks = await runDoctor({
      runner: runnerWith(),
      scheduler: new FakeScheduler(),
      configFile: join(dir, "missing.json"),
      tokenFile: join(dir, "token"),
      fetchHealth: async () => ({ ok: false }),
    });
    expect(checks.some((check) => check.name === "config" && check.level === "fail")).toBe(true);
  });

  test("--offline skips the network checks", async () => {
    const { configFile, tokenFile } = setupFiles();
    const checks = await runDoctor({
      runner: runnerWith(),
      scheduler: new FakeScheduler(),
      configFile,
      tokenFile,
      offline: true,
      fetchHealth: async () => ({ ok: true }),
    });
    expect(checks.some((check) => check.name === "notifications" && check.level === "skip")).toBe(true);
  });
});
