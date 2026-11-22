# github-events-mcp

An event-only [MCP](https://modelcontextprotocol.io) server that watches GitHub and GitHub Enterprise notifications through the `gh` CLI and emits [MCP Events](https://modelcontextprotocol.io/extensions/events/overview). Orbit can wake when a review is requested, CI fails, an issue is assigned or someone mentions you, instead of polling through the model.

> **Status: early.** The events layer, the CLI and the daemon are in place; the notifications poller lands next. See the issues.

## Why it is different

- **Event-only.** No GitHub tools. Orbit already has `gh` in the shell and reads the details itself.
- **Reuses `gh`.** Every call is `gh api --hostname <host>`, so authentication, several hosts and GitHub Enterprise come from `gh auth login`. The server never reads, stores or logs a GitHub token.
- **Polling with conditional requests.** It honors `ETag`, `Last-Modified`, `X-Poll-Interval` and `Retry-After`, and never polls faster than the configured floor.
- **Subscriptions, not a firehose.** Nothing is watched until you run `subscribe`. A notification becomes an event only when its repository matches a subscription on that host.
- **One executable.** TypeScript on Bun, compiled to a single Windows `.exe`, with a per-user logon task. `serve` also runs on macOS and Linux for development.

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

`setup` prints the MCP client fragment: `url` `http://127.0.0.1:<port>/mcp`, `Authorization: Bearer <token>`, protocol `2026-07-28`.

## Events

| Event | From a notification with |
|---|---|
| `github.pr.review_requested` | reason `review_requested` |
| `github.pr.comment` | PullRequest, reason `comment`, `author` or `subscribed` |
| `github.pr.ci_failed` | reason `ci_activity` |
| `github.issue.assigned` | Issue, reason `assign` |
| `github.issue.comment` | Issue, reason `comment`, `author` or `subscribed` |
| `github.mention` | reason `mention` or `team_mention` |

Payloads are thin: `host`, `repo`, `reason`, `subjectType`, `title`, `url`, `updatedAt`, `threadId`. No bodies. Notification text is untrusted and details belong in `gh`.

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
- `src/github`: the only GitHub-specific code, the notifications poller.
- `src/cli` and `src/daemon`: commands and the local Streamable HTTP server.
- `src/platform`: Windows Task Scheduler behind an interface with a fake.

More: [`docs/notifications.md`](docs/notifications.md), [`docs/windows-checklist.md`](docs/windows-checklist.md).

## License

MIT.
