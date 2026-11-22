import { globalHelp, out, fail, parseFlags } from "./cli.ts";
import { NAME, VERSION } from "./version.ts";
import { createScheduler } from "./platform/index.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { installCommand, uninstallCommand, upgradeCommand } from "./commands/lifecycle.ts";
import { serveCommand } from "./commands/serve.ts";
import { setupCommand } from "./commands/setup.ts";
import { subscribeCommand, subscriptionsCommand, unsubscribeCommand } from "./commands/subscriptions.ts";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    globalHelp();
    return 0;
  }
  if (command === "--version" || command === "-v") {
    out(VERSION);
    return 0;
  }

  switch (command) {
    case "version": {
      const parsed = parseFlags("version", { short: { type: "boolean", description: "print only the number" } }, args);
      if (typeof parsed === "number") return parsed;
      out(parsed.values.short ? VERSION : `${NAME} ${VERSION}`);
      return 0;
    }
    case "setup":
      return setupCommand(args);
    case "doctor":
      return doctorCommand(args);
    case "install":
      return installCommand(args, createScheduler());
    case "uninstall":
      return uninstallCommand(args, createScheduler());
    case "upgrade":
      return upgradeCommand(args, createScheduler());
    case "serve":
      return serveCommand(args);
    case "subscribe":
      return subscribeCommand(args);
    case "unsubscribe":
      return unsubscribeCommand(args);
    case "subscriptions":
      return subscriptionsCommand(args);
    default:
      fail(`unknown command "${command}"`);
      globalHelp();
      return 2;
  }
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.exitCode = fail(error instanceof Error ? error.message : String(error));
    });
}
