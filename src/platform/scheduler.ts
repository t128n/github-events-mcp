import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The per-user logon task that keeps `serve` running. */
export const TASK_NAME = "GitHub Events MCP";

export interface TaskSpec {
  exe: string;
  args: string;
  user: string;
  workDir: string;
}

export interface TaskInfo {
  installed: boolean;
  enabled: boolean;
  command: string;
  arguments: string;
  lastResult?: number;
  lastRunTime?: string;
}

export interface Scheduler {
  readonly name: string;
  readonly supported: boolean;
  install(spec: TaskSpec): void;
  uninstall(): void;
  start(): void;
  stop(): void;
  query(): TaskInfo;
  currentUser(): string;
}

const xmlEscape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** At logon of this user, in the user's session, without elevation, no time limit, one instance. */
export function taskXml(spec: TaskSpec): string {
  const user = xmlEscape(spec.user);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Runs the GitHub Events MCP daemon at sign-in for ${user}.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
      <Delay>PT10S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(spec.exe)}</Command>
      <Arguments>${xmlEscape(spec.args)}</Arguments>
      <WorkingDirectory>${xmlEscape(spec.workDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export class WindowsScheduler implements Scheduler {
  readonly name = "Task Scheduler";
  readonly supported = true;

  install(spec: TaskSpec): void {
    const file = join(tmpdir(), `github-events-mcp-task-${process.pid}.xml`);
    // schtasks reads UTF-16 with a byte order mark.
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(spec), "utf16le")]));
    try {
      this.runOrThrow(["schtasks.exe", "/Create", "/TN", TASK_NAME, "/XML", file, "/F"], "register the logon task");
    } finally {
      rmSync(file, { force: true });
    }
  }

  uninstall(): void {
    this.runOrThrow(["schtasks.exe", "/Delete", "/TN", TASK_NAME, "/F"], "remove the logon task");
  }

  start(): void {
    this.runOrThrow(["schtasks.exe", "/Run", "/TN", TASK_NAME], "start the logon task");
  }

  stop(): void {
    // Ending a task that is not running is not an error worth reporting.
    this.run(["schtasks.exe", "/End", "/TN", TASK_NAME]);
  }

  query(): TaskInfo {
    const xml = this.run(["schtasks.exe", "/Query", "/TN", TASK_NAME, "/XML"]);
    if (xml.code !== 0) return { installed: false, enabled: false, command: "", arguments: "" };
    const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml.stdout)?.[1]?.trim() ?? "";
    const settings = /<Settings>[\s\S]*?<\/Settings>/.exec(xml.stdout)?.[0] ?? "";
    const verbose = this.run(["schtasks.exe", "/Query", "/TN", TASK_NAME, "/FO", "LIST", "/V"]);
    const field = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, "im").exec(verbose.stdout)?.[1]?.trim() ?? "";
    const lastResultText = field("Last Result");
    return {
      installed: true,
      enabled: !/<Enabled>\s*false\s*<\/Enabled>/i.test(settings),
      command: tag("Command"),
      arguments: tag("Arguments"),
      ...(lastResultText ? { lastResult: Number(lastResultText) } : {}),
      ...(field("Last Run Time") ? { lastRunTime: field("Last Run Time") } : {}),
    };
  }

  currentUser(): string {
    const domain = process.env.USERDOMAIN;
    const name = process.env.USERNAME;
    if (domain && name) return `${domain}\\${name}`;
    const result = this.run(["whoami.exe"]);
    if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
    throw new Error("cannot tell which Windows user this is");
  }

  private run(command: string[]) {
    try {
      const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", windowsHide: true });
      return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    } catch (error) {
      return { code: 1, stdout: "", stderr: (error as Error).message };
    }
  }

  private runOrThrow(command: string[], what: string): void {
    const result = this.run(command);
    if (result.code !== 0) throw new Error(`schtasks could not ${what}: ${(result.stderr || result.stdout).trim()}`);
  }
}

export class UnsupportedScheduler implements Scheduler {
  readonly name = "none";
  readonly supported = false;
  install(): void {
    throw new Error("the logon task is only available on Windows");
  }
  uninstall(): void {
    throw new Error("the logon task is only available on Windows");
  }
  start(): void {
    throw new Error("the logon task is only available on Windows");
  }
  stop(): void {}
  query(): TaskInfo {
    return { installed: false, enabled: false, command: "", arguments: "" };
  }
  currentUser(): string {
    return process.env.USER ?? process.env.USERNAME ?? "unknown";
  }
}

/** An in-memory scheduler for tests and for checking lifecycle logic on a non-Windows machine. */
export class FakeScheduler implements Scheduler {
  readonly name = "fake";
  readonly supported = true;
  spec: TaskSpec | undefined;
  installed = false;
  running = false;
  calls: string[] = [];
  lastResult: number | undefined = 0;

  install(spec: TaskSpec): void {
    this.calls.push("install");
    this.spec = spec;
    this.installed = true;
  }
  uninstall(): void {
    this.calls.push("uninstall");
    this.installed = false;
    this.running = false;
  }
  start(): void {
    this.calls.push("start");
    this.running = true;
  }
  stop(): void {
    this.calls.push("stop");
    this.running = false;
  }
  query(): TaskInfo {
    return {
      installed: this.installed,
      enabled: this.installed,
      command: this.spec?.exe ?? "",
      arguments: this.spec?.args ?? "",
      ...(this.lastResult !== undefined ? { lastResult: this.lastResult } : {}),
    };
  }
  currentUser(): string {
    return "EXAMPLE\\user";
  }
}
