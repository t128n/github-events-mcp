import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { compareVersions, VERSION } from "../version.ts";
import { configDir, installedExe, installDir, stateDir } from "../config/home.ts";
import { isCompiled, isWindows, type Scheduler } from "../platform/index.ts";
import { removeFile, replaceFile } from "../platform/files.ts";
import { processRunner, type ProcessRunner } from "../platform/process.ts";
import { booleanFlag, fail, out, parseFlags, stringFlag } from "../cli.ts";

const WINDOWS_ONLY = "the logon task is only available on Windows";
const INSTALL_FLAGS = { "no-start": { type: "boolean", description: "register the task but do not start it now" } } as const;
const UNINSTALL_FLAGS = { purge: { type: "boolean", description: "also delete config, token and state" } } as const;
const UPGRADE_FLAGS = {
  force: { type: "boolean", description: "allow a downgrade" },
  from: { type: "string", arg: "path", description: "the new executable (default: the one running this command)" },
} as const;

export interface InstallInput {
  scheduler: Scheduler;
  selfPath: string;
  installedPath: string;
  workDir: string;
  start?: boolean;
  readFile?: (path: string) => Uint8Array;
}

export function performInstall(input: InstallInput): void {
  mkdirSync(dirname(input.installedPath), { recursive: true, mode: 0o700 });
  input.scheduler.stop();
  if (!samePath(input.selfPath, input.installedPath)) {
    const data = input.readFile ? input.readFile(input.selfPath) : readFileSync(input.selfPath);
    replaceFile(input.installedPath, data);
  }
  input.scheduler.install({
    exe: input.installedPath,
    args: "serve",
    user: input.scheduler.currentUser(),
    workDir: input.workDir,
  });
  if (input.start !== false) input.scheduler.start();
}

export interface UninstallInput {
  scheduler: Scheduler;
  installedPath: string;
  purge?: boolean;
  configDir?: string;
  stateDir?: string;
}

export function performUninstall(input: UninstallInput): "removed" | "deferred" {
  input.scheduler.stop();
  if (input.scheduler.query().installed) input.scheduler.uninstall();
  const result = removeFile(input.installedPath);
  if (input.purge) {
    for (const dir of new Set([input.configDir ?? configDir(), input.stateDir ?? stateDir()])) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return result;
}

export interface UpgradeInput {
  scheduler: Scheduler;
  installedPath: string;
  selfPath: string;
  oldVersion: string;
  newVersion: string;
  force?: boolean;
  copyFile?: (from: string, to: string) => void;
  /** Runs `<exe> version --short`; throws when the exe does not start or reports another version. */
  readVersion: (path: string) => Promise<string> | string;
}

export interface UpgradeResult {
  oldVersion: string;
  newVersion: string;
  previousMoved: boolean;
}

/**
 * Replaces the installed exe with `selfPath`. The old exe is renamed aside first; the new copy
 * must start and report `newVersion` before the old one is dropped. No network access.
 */
export async function performUpgrade(input: UpgradeInput): Promise<UpgradeResult> {
  if (!input.scheduler.query().installed) throw new Error("the logon task is not installed; run install first");
  if (!existsSync(input.installedPath)) throw new Error(`the installed exe is missing: ${input.installedPath}`);
  if (samePath(input.selfPath, input.installedPath)) throw new Error("run the new exe, not the installed one");
  if (compareVersions(input.newVersion, input.oldVersion) < 0 && !input.force) {
    throw new Error(`refusing to downgrade from ${input.oldVersion} to ${input.newVersion}; pass --force`);
  }

  const oldPath = `${input.installedPath}.previous`;
  input.scheduler.stop();
  try {
    rmSync(oldPath, { force: true });
    renameSync(input.installedPath, oldPath);
  } catch (error) {
    try {
      input.scheduler.start();
    } catch {
      // reported below
    }
    throw new Error(`could not move the installed exe aside: ${(error as Error).message}`);
  }

  const restore = (reason: string): never => {
    try {
      rmSync(input.installedPath, { force: true });
      renameSync(oldPath, input.installedPath);
    } catch (error) {
      throw new Error(`${reason}; restoring the old exe also failed: ${(error as Error).message}`);
    }
    try {
      input.scheduler.start();
    } catch {
      // The old exe is back; starting it is the task scheduler's job now.
    }
    throw new Error(`${reason}; the old exe was restored`);
  };

  try {
    if (input.copyFile) input.copyFile(input.selfPath, input.installedPath);
    else replaceFile(input.installedPath, readFileSync(input.selfPath));
  } catch (error) {
    restore(`could not copy the new exe: ${(error as Error).message}`);
  }

  let actual = "";
  try {
    actual = (await input.readVersion(input.installedPath)).trim();
  } catch (error) {
    restore(`the new exe did not start: ${(error as Error).message}`);
  }
  if (actual !== input.newVersion) restore(`the new exe reports ${actual}, expected ${input.newVersion}`);

  rmSync(oldPath, { force: true });
  input.scheduler.start();
  return { oldVersion: input.oldVersion, newVersion: input.newVersion, previousMoved: true };
}

export async function installCommand(args: string[], scheduler: Scheduler): Promise<number> {
  const parsed = parseFlags("install", INSTALL_FLAGS, args);
  if (typeof parsed === "number") return parsed;
  if (!isWindows) return fail(WINDOWS_ONLY);
  if (!isCompiled()) return fail("install copies the exe; run it from the built executable, not from bun");
  try {
    performInstall({
      scheduler,
      selfPath: process.execPath,
      installedPath: installedExe(),
      workDir: installDir(),
      start: !booleanFlag(parsed.values, "no-start"),
    });
  } catch (error) {
    return fail((error as Error).message);
  }
  out(`Installed ${installedExe()}`);
  out(`Registered the logon task "${scheduler.name}" for ${scheduler.currentUser()}.`);
  if (booleanFlag(parsed.values, "no-start")) out("Not started (--no-start). Start it with: github-events-mcp install");
  else out("Started. The daemon runs now and again at every sign-in.");
  return 0;
}

export async function uninstallCommand(args: string[], scheduler: Scheduler): Promise<number> {
  const parsed = parseFlags("uninstall", UNINSTALL_FLAGS, args);
  if (typeof parsed === "number") return parsed;
  if (!isWindows) return fail(WINDOWS_ONLY);
  try {
    const result = performUninstall({
      scheduler,
      installedPath: installedExe(),
      purge: booleanFlag(parsed.values, "purge"),
      configDir: configDir(),
      stateDir: stateDir(),
    });
    out("Stopped and removed the logon task.");
    if (result === "deferred") out("The running exe is removed a moment after it exits.");
    out(booleanFlag(parsed.values, "purge") ? "Config, token and state removed." : "Config and subscriptions kept. Re-install with: github-events-mcp install");
  } catch (error) {
    return fail((error as Error).message);
  }
  return 0;
}

export async function upgradeCommand(args: string[], scheduler: Scheduler, runner: ProcessRunner = processRunner): Promise<number> {
  const parsed = parseFlags("upgrade", UPGRADE_FLAGS, args);
  if (typeof parsed === "number") return parsed;
  if (!isWindows) return fail(`upgrade replaces the Windows executable; build from source on ${process.platform}`);
  const installed = installedExe();
  if (!existsSync(installed)) return fail(`not installed at ${installed}; run install first`);

  const readVersion = async (path: string): Promise<string> => {
    const result = await runner.run([path, "version", "--short"], { timeoutMs: 15_000 });
    if (result.code !== 0) throw new Error(result.stderr.trim() || `exit ${result.code}`);
    return result.stdout.trim();
  };

  let oldVersion: string;
  try {
    oldVersion = await readVersion(installed);
  } catch (error) {
    return fail(`the installed exe did not answer "version": ${(error as Error).message}`);
  }
  const selfPath = stringFlag(parsed.values, "from", process.execPath)!;
  if (!booleanFlag(parsed.values, "force") && !isCompiled() && selfPath === process.execPath) {
    return fail("upgrade needs the new executable; run <new>.exe upgrade");
  }
  let newVersion: string;
  try {
    newVersion = selfPath === process.execPath ? VERSION : await readVersion(selfPath);
  } catch (error) {
    return fail(`the new exe did not answer "version": ${(error as Error).message}`);
  }

  out(`Installed: ${oldVersion}   New: ${newVersion}`);
  try {
    const result = await performUpgrade({ scheduler, installedPath: installed, selfPath, oldVersion, newVersion, force: booleanFlag(parsed.values, "force"), readVersion });
    out(`Upgraded from ${result.oldVersion} to ${result.newVersion}.`);
    out("The logon task is running.");
  } catch (error) {
    return fail((error as Error).message);
  }
  return 0;
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

/** Exported for tests; the CLI uses the real scheduler and the paths from `home.ts`. */
export const lifecyclePaths = { installDir, installedExe };
