import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Replaces `path` with `data` even when `path` is a running program. Windows allows renaming a
 * running executable, so the old file is moved aside first and removed when it can be.
 */
export function replaceFile(path: string, data: Uint8Array): void {
  const next = `${path}.new`;
  const old = `${path}.old`;
  writeFileSync(next, data, { mode: 0o755 });
  try {
    rmSync(old, { force: true });
  } catch {
    // An earlier .old is still in use; the rename below reports it.
  }
  try {
    if (existsSync(path)) renameSync(path, old);
    renameSync(next, path);
  } catch (error) {
    rmSync(next, { force: true });
    if (existsSync(old) && !existsSync(path)) renameSync(old, path);
    throw error;
  }
  try {
    rmSync(old, { force: true });
  } catch {
    // Still running: the next install or upgrade removes it.
  }
}

/** Removes a file; a running program is renamed aside and deleted a moment later by cmd. */
export function removeFile(path: string): "removed" | "deferred" {
  if (!existsSync(path)) return "removed";
  try {
    rmSync(path);
    return "removed";
  } catch {
    if (process.platform !== "win32") throw new Error(`could not remove ${path}`);
    const aside = `${path}.old`;
    try {
      rmSync(aside, { force: true });
      renameSync(path, aside);
    } catch (error) {
      throw new Error(`could not move ${path} aside: ${(error as Error).message}`);
    }
    Bun.spawn(["cmd.exe", "/d", "/c", `ping -n 4 127.0.0.1 >nul & del /f /q "${aside}"`], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    }).unref();
    return "deferred";
  }
}
