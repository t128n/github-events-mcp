# github-events-mcp

An event-only [MCP](https://modelcontextprotocol.io) server that watches GitHub and GitHub Enterprise through the `gh` CLI and emits [MCP Events](https://modelcontextprotocol.io/extensions/events/overview). Orbit can wake when a review is requested, an issue or pull request is created, CI fails on a branch, an issue is assigned or someone mentions you, instead of polling through the model.

> **Status: early.** Notifications, created items, branch CI, the CLI and the daemon are in place. The Windows installer and upgrade flow still need a real Windows pass; see [`docs/windows-checklist.md`](docs/windows-checklist.md).

## Why it is different

- **Event-only.** No GitHub tools. Orbit already has `gh` in the shell and reads the details itself.
- **Reuses `gh`.** Every call is `gh api --hostname <host>`, so authentication, several hosts and GitHub Enterprise come from `gh auth login`. The server never reads, stores or logs a GitHub token.
- **Polling with conditional requests.** It honors `ETag`, `Last-Modified`, `X-Poll-Interval` and `Retry-After`, and never polls faster than the configured floor.
- **Subscriptions, not a firehose.** Nothing is watched until you run `subscribe`. A notification becomes an event only when its repository matches a subscription on that host.
- **One executable.** TypeScript on Bun, compiled to a single Windows `.exe`, with a per-user logon task. `serve` also runs on macOS and Linux for development.

## Install

```sh
MISE_MINIMUM_RELEASE_AGE=0 mise use -g github:t128n/github-events-mcp@latest
```

mise hides very new releases for 24 hours by default; the prefix skips that wait. The release attaches `github-events-mcp-windows-x64.exe`; mise installs it as `github-events-mcp`. See [`docs/install.md`](docs/install.md).

## Let your agent set it up

Paste this into OpenCode (or another agent with a shell and file access):

> Set up `github-events-mcp` for me.
>
> 1. Install it with `MISE_MINIMUM_RELEASE_AGE=0 mise use -g github:t128n/github-events-mcp@latest`. If mise is not available or this is a Windows machine without it, download `github-events-mcp-windows-x64.exe` from the latest release instead.
> 2. Run `github-events-mcp setup`. Show me the hosts it finds and the MCP snippet, but do not paste the token into chat.
> 3. Ask me which repositories to watch (`owner/repo` or `owner/*`) and which event types. Then run `github-events-mcp subscribe ...` for each choice.
> 4. Run `github-events-mcp doctor` and fix what you can. If a check needs me, stop and tell me the fix.
> 5. On Windows, run `github-events-mcp install` so it starts at logon.
> 6. Add the printed Streamable HTTP URL to OpenCode with `Authorization: Bearer <token>` and protocol `2026-07-28`.
>
> Do not subscribe anything without asking me first. Do not print the token, event payloads or notification text.

## Commands

```sh
github-events-mcp setup          # hosts, port, token, MCP client snippet
github-events-mcp doctor         # one line per check, with the fix
github-events-mcp subscribe owner/repo [--host H] [--events a,b]
github-events-mcp unsubscribe owner/repo [--host H]
github-events-mcp subscriptions
github-events-mcp serve          # foreground daemon
github-events-mcp install        # Windows: copy the exe and register a logon task
github-events-mcp uninstall      # Windows: remove the task (--purge removes config too)
github-events-mcp upgrade        # Windows: run the new exe as: <new>.exe upgrade
github-events-mcp version
```

`setup` prints the MCP client fragment: `url` `http://127.0.0.1:<port>/mcp`, `Authorization: Bearer <token>`, protocol `2026-07-28`. The default local port is **41387**; `setup` picks another free port if that one is taken.

## Events

### Notifications

| Event | From a notification with |
|---|---|
| `github.pr.review_requested` | reason `review_requested` |
| `github.pr.comment` | PullRequest, reason `comment`, `author` or `subscribed` |
| `github.pr.ci_failed` | reason `ci_activity` (notification-based; GitHub does not say pass/fail) |
| `github.issue.assigned` | Issue, reason `assign` |
| `github.issue.comment` | Issue, reason `comment`, `author` or `subscribed` |
| `github.mention` | reason `mention` or `team_mention` |

### Repository poll

| Event | Fires when |
|---|---|
| `github.issue.created` | a new issue appears in a subscribed repository |
| `github.pr.created` | a new pull request appears in a subscribed repository |
| `github.ci.failed` | a completed Actions run has a failure-like conclusion; payload includes `branch`, `workflow` and `conclusion` |

`github.ci.failed` is the reliable branch CI event. `github.pr.ci_failed` remains for compatibility as the notification-based event, but it cannot tell a failed run from a passing one. Prefer the former.

Payloads are thin and untrusted:

- Notifications: `host`, `repo`, `reason`, `subjectType`, `title`, `url`, `updatedAt`, `threadId`.
- Created: `host`, `repo`, `number`, `title`, `url`, `author`, `subjectType`, `createdAt`, `updatedAt`.
- CI: `host`, `repo`, `branch`, `workflow`, `conclusion`, `event`, `runId`, `attempt`, `url`, `updatedAt`.

No bodies, commit messages or logs. Details belong in `gh`.

Created items and CI are polled per repository. A wildcard subscription (`owner/*`) resolves the owner's repositories and caches the list for ten minutes. Conditional requests keep unchanged polls cheap.

## Security

- The daemon listens on `127.0.0.1` only.
- Every MCP request needs the bearer token; `/health` is the only unauthenticated endpoint.
- A foreign `Host` or `Origin` is rejected, to block DNS rebinding.
- Config, token and state files are readable by the current user only.
- No GitHub token is ever read, stored or logged.

## Development

```sh
bun install
bun test
bunx tsc --noEmit
bun run build          # dist/github-events-mcp.exe (bun-windows-x64)
```

- `packages/events`: protocol, shared poll loops, cursors, back-off. No GitHub code.
- `src/github`: the only GitHub-specific code: notifications, created items, branch CI and repository discovery.
- `src/cli` and `src/daemon`: commands and the local Streamable HTTP server.
- `src/platform`: Windows Task Scheduler behind an interface with a fake.

More: [`docs/install.md`](docs/install.md), [`docs/notifications.md`](docs/notifications.md), [`docs/windows-checklist.md`](docs/windows-checklist.md).

## License

MIT.
