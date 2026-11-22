import { tokenPath, readSecret } from "../config/home.ts";
import type { Config } from "../config/config.ts";

export type ReloadResult = "reloaded" | "not-running" | "unauthorized" | "error";

/** Asks a running daemon to re-read the config. Best effort: no daemon is a normal state. */
export async function reloadDaemon(config: Config, tokenFile = tokenPath(), timeoutMs = 1_500): Promise<ReloadResult> {
  const token = readSecret(tokenFile);
  if (!token) return "not-running";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/admin/reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (response.ok) return "reloaded";
    if (response.status === 401 || response.status === 403) return "unauthorized";
    return "error";
  } catch {
    return "not-running";
  } finally {
    clearTimeout(timer);
  }
}

export function reloadNote(result: ReloadResult): string | undefined {
  switch (result) {
    case "reloaded":
      return "The running daemon reloaded the config.";
    case "unauthorized":
      return "A daemon answered but rejected the token; run setup again or check the token file.";
    case "error":
      return "A daemon answered but could not reload; check its log.";
    default:
      return undefined;
  }
}
