# github-events-mcp

An event-only [MCP](https://modelcontextprotocol.io) server that polls GitHub and GitHub Enterprise through the `gh` CLI and emits [MCP Events](https://modelcontextprotocol.io/extensions/events/overview) for pull requests and issues. An agent can then wake when something happens, instead of polling through the model.

> **Status: planning.** Nothing is built yet. See the issues.

## Idea

- **Event-only.** No GitHub tools. Agents already have `gh` in the shell. This server only tells them *that* something happened. They fetch details themselves.
- **Reuses `gh`.** It runs `gh api --hostname <host>`, so authentication and GitHub Enterprise hosts come from your existing `gh auth login`. The server never handles a token for GitHub.
- **Polling.** It reads the notifications API with conditional requests and respects `X-Poll-Interval`.
- **One executable** for Windows, built with Bun, with the commands `setup`, `doctor`, `install`, `uninstall` and `upgrade`. `install` registers a Task Scheduler task that runs at log on.

## Planned events

`github.pr.review_requested`, `github.pr.comment`, `github.pr.ci_failed`, `github.issue.assigned`, `github.issue.comment`, `github.mention`. Payloads are thin: host, repository, reason, title and URL.

## License

MIT.
