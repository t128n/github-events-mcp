import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performInstall, performUninstall, performUpgrade } from "../src/commands/lifecycle.ts";
import { FakeScheduler } from "../src/platform/scheduler.ts";
import { compareVersions } from "../src/version.ts";
import { taskXml } from "../src/platform/scheduler.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "github-events-lifecycle-"));
  dirs.push(dir);
  return dir;
}

describe("install", () => {
  test("copies the exe and registers and starts a per-user task", () => {
    const dir = temp();
    const self = join(dir, "new.exe");
    writeFileSync(self, "new-exe");
    const installed = join(dir, "bin", "github-events-mcp.exe");
    const scheduler = new FakeScheduler();
    performInstall({ scheduler, selfPath: self, installedPath: installed, workDir: join(dir, "bin") });
    expect(readFileSync(installed, "utf8")).toBe("new-exe");
    expect(scheduler.installed).toBe(true);
    expect(scheduler.running).toBe(true);
    expect(scheduler.spec?.args).toBe("serve");
    expect(scheduler.spec?.user).toBe("EXAMPLE\\user");
  });

  test("does not copy an exe onto itself", () => {
    const dir = temp();
    const installed = join(dir, "github-events-mcp.exe");
    writeFileSync(installed, "same");
    const scheduler = new FakeScheduler();
    performInstall({ scheduler, selfPath: installed, installedPath: installed, workDir: dir, start: false });
    expect(readFileSync(installed, "utf8")).toBe("same");
    expect(scheduler.installed).toBe(true);
    expect(scheduler.running).toBe(false);
  });

  test("uninstall stops and removes the task and keeps the config unless purged", () => {
    const dir = temp();
    const installed = join(dir, "bin", "github-events-mcp.exe");
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(installed, "exe");
    const scheduler = new FakeScheduler();
    scheduler.installed = true;
    scheduler.running = true;
    expect(performUninstall({ scheduler, installedPath: installed, configDir: join(dir, "config"), stateDir: join(dir, "state") })).toBe("removed");
    expect(scheduler.installed).toBe(false);
    expect(existsSync(installed)).toBe(false);
  });

  test("uninstall --purge removes config and state", () => {
    const dir = temp();
    const config = join(dir, "config");
    const state = join(dir, "state");
    mkdirSync(config);
    mkdirSync(state);
    writeFileSync(join(config, "config.json"), "{}");
    writeFileSync(join(state, "state.json"), "{}");
    const scheduler = new FakeScheduler();
    performUninstall({ scheduler, installedPath: join(dir, "none.exe"), purge: true, configDir: config, stateDir: state });
    expect(existsSync(config)).toBe(false);
    expect(existsSync(state)).toBe(false);
  });
});

describe("upgrade", () => {
  function setupFiles(oldVersion: string, newVersion: string) {
    const dir = temp();
    const installed = join(dir, "github-events-mcp.exe");
    const self = join(dir, "new.exe");
    writeFileSync(installed, `exe-${oldVersion}`);
    writeFileSync(self, `exe-${newVersion}`);
    const scheduler = new FakeScheduler();
    scheduler.installed = true;
    scheduler.running = true;
    return { dir, installed, self, scheduler };
  }

  test("replaces the exe, self-checks it, removes the old one and restarts", async () => {
    const { installed, self, scheduler } = setupFiles("0.1.0", "0.2.0");
    const readVersion = (path: string) => (readFileSync(path, "utf8") === "exe-0.2.0" ? "0.2.0" : "0.1.0");
    const result = await performUpgrade({
      scheduler,
      installedPath: installed,
      selfPath: self,
      oldVersion: "0.1.0",
      newVersion: "0.2.0",
      readVersion,
    });
    expect(result).toEqual({ oldVersion: "0.1.0", newVersion: "0.2.0", previousMoved: true });
    expect(readFileSync(installed, "utf8")).toBe("exe-0.2.0");
    expect(existsSync(`${installed}.old`)).toBe(false);
    expect(scheduler.running).toBe(true);
    expect(scheduler.calls).toContain("stop");
    expect(scheduler.calls).toContain("start");
  });

  test("refuses a downgrade without --force", async () => {
    const { installed, self, scheduler } = setupFiles("2.0.0", "1.0.0");
    await expect(
      performUpgrade({
        scheduler,
        installedPath: installed,
        selfPath: self,
        oldVersion: "2.0.0",
        newVersion: "1.0.0",
        readVersion: () => "1.0.0",
      }),
    ).rejects.toThrow("refusing to downgrade");
    expect(readFileSync(installed, "utf8")).toBe("exe-2.0.0");
    expect(scheduler.calls).not.toContain("stop");
  });

  test("restores the old exe when the new one fails its self-check", async () => {
    const { installed, self, scheduler } = setupFiles("0.1.0", "0.2.0");
    await expect(
      performUpgrade({
        scheduler,
        installedPath: installed,
        selfPath: self,
        oldVersion: "0.1.0",
        newVersion: "0.2.0",
        readVersion: () => {
          throw new Error("does not start");
        },
      }),
    ).rejects.toThrow("the old exe was restored");
    expect(readFileSync(installed, "utf8")).toBe("exe-0.1.0");
    expect(scheduler.running).toBe(true);
  });

  test("restores the old exe when the new one reports the wrong version", async () => {
    const { installed, self, scheduler } = setupFiles("0.1.0", "0.2.0");
    await expect(
      performUpgrade({
        scheduler,
        installedPath: installed,
        selfPath: self,
        oldVersion: "0.1.0",
        newVersion: "0.2.0",
        readVersion: () => "9.9.9",
      }),
    ).rejects.toThrow("reports 9.9.9");
    expect(readFileSync(installed, "utf8")).toBe("exe-0.1.0");
  });

  test("fails when the task is not installed", async () => {
    const dir = temp();
    const installed = join(dir, "github-events-mcp.exe");
    const self = join(dir, "new.exe");
    writeFileSync(installed, "old");
    writeFileSync(self, "new");
    await expect(
      performUpgrade({
        scheduler: new FakeScheduler(),
        installedPath: installed,
        selfPath: self,
        oldVersion: "0.1.0",
        newVersion: "0.2.0",
        readVersion: () => "0.2.0",
      }),
    ).rejects.toThrow("not installed");
  });
});

describe("version comparison", () => {
  test("orders versions", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("v0.9.0", "1.0.0")).toBe(-1);
  });
});

describe("task XML", () => {
  test("is a per-user interactive logon task without a time limit", () => {
    const xml = taskXml({ exe: "C:\\Program Files\\App\\app.exe", args: "serve", user: "EXAMPLE\\user", workDir: "C:\\Program Files\\App" });
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<Delay>PT10S</Delay>");
    expect(xml).toContain("<RestartOnFailure>");
    expect(xml).not.toContain("<RunLevel>HighestAvailable</RunLevel>");
  });
});
