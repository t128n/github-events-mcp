import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { NAME, VERSION } from "./version.ts";

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

export const out = (text = ""): void => void process.stdout.write(text + "\n");
export const err = (text: string): void => void process.stderr.write(text + "\n");

export function fail(message: string): number {
  err(`${NAME}: ${message.trim()}`);
  return 1;
}

export const interactive = (): boolean => !!process.stdin.isTTY;

export async function ask(prompt: string, fallback = ""): Promise<string> {
  if (!interactive()) return fallback;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(fallback ? `${prompt} [${fallback}]: ` : `${prompt}: `)).trim();
    return answer || fallback;
  } finally {
    readline.close();
  }
}

export interface FlagDef {
  type: "string" | "boolean";
  description: string;
  arg?: string;
  multiple?: boolean;
  short?: string;
}

export type Flags = Record<string, FlagDef>;
export type FlagValues = Record<string, string | boolean | string[] | undefined>;

export function parseFlags(
  command: string,
  spec: Flags,
  args: string[],
): { values: FlagValues; positionals: string[] } | number {
  const usage = (): void => {
    out(`Usage: ${NAME} ${command} [options]${needsPositionals(command) ? " <argument>" : ""}\n`);
    for (const [name, flag] of Object.entries(spec)) {
      const left = `--${name}${flag.type === "string" ? ` <${flag.arg ?? "value"}>` : ""}`;
      out(`  ${left.padEnd(30)} ${flag.description}`);
    }
    out(`  ${"--help, -h".padEnd(30)} show this help`);
  };
  try {
    const result = parseArgs({
      args,
      allowPositionals: true,
      options: {
        ...Object.fromEntries(
          Object.entries(spec).map(([name, flag]) => [
            name,
            { type: flag.type, ...(flag.multiple ? { multiple: true } : {}), ...(flag.short ? { short: flag.short } : {}) },
          ]),
        ),
        help: { type: "boolean", short: "h" },
      },
    });
    if (result.values.help) {
      usage();
      return 0;
    }
    return { values: result.values as FlagValues, positionals: result.positionals };
  } catch (error) {
    err(`${NAME} ${command}: ${(error as Error).message}`);
    usage();
    return 2;
  }
}

function needsPositionals(command: string): boolean {
  return ["subscribe", "unsubscribe"].includes(command);
}

/** A file path, default or environment value as a single string. */
export function stringFlag(values: FlagValues, name: string, fallback?: string): string | undefined {
  const value = values[name];
  if (typeof value === "string") return value;
  return fallback;
}

export function booleanFlag(values: FlagValues, name: string): boolean {
  return values[name] === true;
}

export function listFlag(values: FlagValues, name: string): string[] {
  const value = values[name];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

export function globalHelp(): void {
  out(`${NAME} ${VERSION}`);
  out("");
  out("An event-only MCP server that watches GitHub notifications through the gh CLI.");
  out("");
  out("Usage: " + NAME + " <command> [options]");
  out("");
  out("Commands:");
  const commands: Array<[string, string]> = [
    ["setup", "first-time configuration, token and MCP client snippet"],
    ["doctor", "check every prerequisite and say what to fix"],
    ["install", "copy the exe and register the per-user logon task (Windows)"],
    ["uninstall", "stop and remove the logon task"],
    ["upgrade", "replace the installed exe with the one you just ran"],
    ["serve", "run the local daemon in the foreground"],
    ["subscribe", "watch a repository or an owner's repositories"],
    ["unsubscribe", "stop watching one"],
    ["subscriptions", "list what is watched"],
    ["version", "print the version"],
  ];
  for (const [command, description] of commands) out(`  ${command.padEnd(16)} ${description}`);
  out("");
  out(`Run "${NAME} <command> --help" for a command's options.`);
}

export const APP_DESCRIPTION = "GitHub Events MCP";
