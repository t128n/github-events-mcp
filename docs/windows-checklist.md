# Manual Windows checklist

These steps were **not** run for this change. It was built and tested on macOS, and the Windows-only code is covered by tests with a fake scheduler and temp files. Do this on a real Windows account before calling `install`, `uninstall` and `upgrade` done.

Use a throwaway repository and a test account. Do not paste tokens, notification text or internal host names into the issue.

## 1. Build and first run

```powershell
bun install
bun run build
dist\github-events-mcp.exe version
dist\github-events-mcp.exe --help
```

- [ ] `version` prints `0.1.0` (or the current version).
- [ ] `--help` lists all commands.
- [ ] The exe is a single file; no Bun runtime is installed.

## 2. Setup

```powershell
dist\github-events-mcp.exe setup --host github.com
```

- [ ] The hosts that `gh auth status` lists are shown; `github.com` is the default.
- [ ] `%LOCALAPPDATA%\GitHubEventsMCP\config.json` and `token` exist.
- [ ] `icacls "%LOCALAPPDATA%\GitHubEventsMCP"` shows only the current user (and SYSTEM/Administrators if the OS adds them).
- [ ] The printed MCP snippet has the loopback URL, the bearer token and protocol `2026-07-28`.
- [ ] Make a note of the port and token for the tests below.

## 3. Doctor and serve before install

```powershell
dist\github-events-mcp.exe doctor
dist\github-events-mcp.exe serve
```

- [ ] `doctor` prints one `PASS`, `FAIL` or `SKIP` line per check, and a `fix:` line for failures. It exits non-zero when something fails.
- [ ] Before `install`, the logon-task and health checks fail with a fix that points at `install` / `serve`; that is expected.
- [ ] With `serve` running, `http://127.0.0.1:<port>/health` answers without a token.
- [ ] A request without `Authorization` gets `401`.
- [ ] A request with `Origin: https://evil.example` gets `403`.
- [ ] Ctrl+C stops the process.

## 4. Install and logon

```powershell
dist\github-events-mcp.exe install
schtasks /Query /TN "GitHub Events MCP" /XML
```

- [ ] `%LOCALAPPDATA%\GitHubEventsMCP\bin\github-events-mcp.exe` exists.
- [ ] The task exists and its XML has:
  - `<LogonType>InteractiveToken</LogonType>`
  - `<RunLevel>LeastPrivilege</RunLevel>`
  - `<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`
  - `<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`
  - `<RestartOnFailure>` with a non-zero count
  - a small `<Delay>` on the logon trigger
- [ ] It did **not** ask for administrator rights.
- [ ] `/health` answers without starting a second `serve` by hand.
- [ ] Sign out and back in. Wait for the delay. `/health` answers again.
- [ ] `doctor` now passes the logon-task and health checks.

## 5. Subscriptions and a real event

```powershell
github-events-mcp subscribe <owner>/<repo> --host github.com
github-events-mcp subscriptions
```

- [ ] The config lists the subscription.
- [ ] The running daemon picks it up without a restart (`/health` shows one subscription).
- [ ] Trigger a review request, a comment or a mention from another account.
- [ ] The event appears within about one poll interval in the MCP client. Payload has `host`, `repo`, `reason`, `subjectType`, `title`, `url`, `updatedAt`, `threadId`; no body.

```powershell
github-events-mcp unsubscribe <owner>/<repo> --host github.com
```

- [ ] `/health` shows zero subscriptions and the event flow stops immediately.
- [ ] With no subscriptions at all, the daemon makes no `gh api` call. Check with a `gh` wrapper that logs arguments, or by watching the rate-limit counter.

## 6. Uninstall

```powershell
github-events-mcp uninstall
schtasks /Query /TN "GitHub Events MCP"
```

- [ ] The query fails because the task is gone.
- [ ] The daemon stopped.
- [ ] The config and subscriptions are still there.
- [ ] `uninstall --purge` removes the config, token and state.

## 7. Upgrade

Build a second exe whose `src/version.ts` is higher, then:

```powershell
.\github-events-mcp-new.exe upgrade
```

- [ ] It stops the task, replaces the installed exe, runs `version --short` on the new copy, restarts the task and prints old and new versions.
- [ ] No network access is needed.
- [ ] `github-events-mcp version` reports the new version.
- [ ] A downgrade is refused without `--force`.

Rollback:

```powershell
# Point the upgrade at a file that is not a working exe.
.\github-events-mcp-new.exe upgrade --from C:\Windows\Temp\not-an-exe.txt
```

- [ ] It fails the self-check, restores the previous exe, restarts the task, and prints a message that the old exe was restored.
- [ ] `/health` answers on the old version afterwards.

## 8. Report back

Post one comment on the tracking issue with:

- Windows version and whether it was a standard user or administrator.
- Which steps passed or failed, with the exact command output for a failure (redact tokens, repositories and host names).
- Whether the logon task and the upgrade rollback worked.
- Anything `doctor` did not catch.
