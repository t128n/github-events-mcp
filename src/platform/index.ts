import { FakeScheduler, UnsupportedScheduler, WindowsScheduler, type Scheduler } from "./scheduler.ts";

export const isWindows = process.platform === "win32";

/** A compiled exe runs as itself; `bun src/main.ts` runs as bun. */
export const isCompiled = (): boolean => !/^bun(-profile)?(\.exe)?$/i.test(process.execPath.split(/[\\/]/).pop() ?? "");

export function createScheduler(): Scheduler {
  return isWindows ? new WindowsScheduler() : new UnsupportedScheduler();
}

export { FakeScheduler, UnsupportedScheduler, WindowsScheduler };
export type { Scheduler, TaskInfo, TaskSpec } from "./scheduler.ts";
