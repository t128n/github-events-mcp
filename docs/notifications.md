# How the pollers talk to GitHub

The pollers run `gh`; they never open a socket to GitHub themselves and never read a token. One loop per subscribed host calls the notifications API. A second loop polls subscribed repositories for created issues and pull requests and for branch CI. Each loop has its own opaque cursor.

## The request

```sh
gh api -i --hostname github.com \
  "/notifications?all=false&since=2026-01-02T03%3A04%3A05Z&per_page=50" \
  -H "Accept: application/vnd.github+json" \
  -H 'If-None-Match: W/"..."' \
  -H "If-Modified-Since: Thu, 01 Jan 2026 00:00:00 GMT"
```

- `all=false` is the default `participatingOnly` setting. `setup --all` sends `all=true`.
- `since` is the last `updated_at` that was seen for that host.
- The first poll has no cursor. It calls once with `since=<now>` and discards anything the API returns, so old notifications do not flood the agent.
- The validators come from the previous response for that host.

## What was verified

On 2026-11-22, against `github.com` with a personal login and `gh 2.101.0`:

| Check | Result |
|---|---|
| `GET /notifications` through `gh api -i` | `HTTP/2.0 200`, JSON array, `ETag`, `Last-Modified`, `X-Poll-Interval: 60` |
| Accepted scopes | `X-Accepted-OAuth-Scopes: notifications, repo`; the existing `repo` scope was enough |
| Conditional request with a matching `If-None-Match` | `HTTP/2.0 304 Not Modified` |
| `gh` exit code on that `304` | **1**, with `gh: HTTP 304` on stderr |
| What `gh api -i` prints on a `304` | the status line and headers on stdout, then a blank line, **no body** |
| Second conditional request using the ETag from the previous `200` | sometimes a fresh `200` with a different ETag and the same body; the poller stores the new ETag and relies on stable `eventId`s |

The `304` finding matters: the poller treats a non-zero `gh` exit as a failure only when the parsed status is not `304`. A `304` is a successful poll with no events.

The same `200` with validators and `X-Poll-Interval: 60` was already observed on a GHE.com host in #5. This repository does not contain its name.

## Cursor

- Per host: `since` (last `updated_at`), `etag`, `lastModified`, `nextPollMs`.
- The client sees one opaque base64url string containing all hosts. It is persisted by the events package.
- `eventId` is `host:threadId:updated_at`, so a new comment on the same thread is a new event.
- An unchanged poll sends the validators. If GitHub still returns `200`, the same notifications produce the same `eventId`s and the hub drops the duplicates.

## Interval, rate limits and auth

- `X-Poll-Interval` × 1000 is the next delay, never below `pollFloorSeconds` (default 60).
- `Retry-After` and a secondary-rate-limit `403`/`429` back that host off for the given time.
- `401`, or a `403` without a rate-limit signal, pauses the host. Other hosts continue. `doctor` shows the paused host, and the pause is retried after 15 minutes or when the daemon reloads.
- `X-RateLimit-Remaining` is checked by `doctor`, not by every poll.

## Notification to event

| Notification | Event |
|---|---|
| reason `mention` or `team_mention` | `github.mention` |
| reason `ci_activity` | `github.pr.ci_failed` |
| reason `review_requested`, subject `PullRequest` | `github.pr.review_requested` |
| subject `PullRequest`, reason `comment`, `author` or `subscribed` | `github.pr.comment` |
| subject `Issue`, reason `assign` | `github.issue.assigned` |
| subject `Issue`, reason `comment`, `author` or `subscribed` | `github.issue.comment` |

Everything else is ignored: `manual`, `state_change`, `invitation`, security advisories, and so on. A mention wins over the subject type, so a mention in a Discussion still becomes `github.mention`.

### `ci_activity` does not say pass or fail

GitHub's API documentation says `ci_activity` means "a workflow run that you triggered was completed". The notification payload does not include the run conclusion. The event is therefore named `github.pr.ci_failed` because that is what #5 specifies, but **the poller cannot tell a failed run from a passing one**. Whether GitHub sends the notification for successful runs depends on the user's notification settings. Treat the event as "CI activity" and check with `gh` before assuming a failure.

### Other subject types

Observed in a real inbox: `Issue`, `PullRequest`. `CheckSuite` is the subject for CI notifications. Discussions can carry mentions; Releases and subscription-only notifications do not map to any notification event. These were **not** observed in the test inbox, so the handling is based on the API shape and is marked unverified.

## Created items

A notification cannot tell "created" from "commented": it is a thread, not an action. Created items come from the repository issues API instead.

```sh
gh api -i --hostname github.com \
  "/repos/owner/repo/issues?state=all&sort=created&direction=desc&per_page=100&since=<cursor>" \
  -H "Accept: application/vnd.github+json" \
  -H 'If-None-Match: W/"..."'
```

- The response contains both issues and pull requests; a pull request has a `pull_request` field.
- The cursor is the newest `created_at` that was handled plus the `since` value, the validators and a bounded set of seen item ids. A same-second item is not lost. The `since` window carries a ten-minute overlap so a delayed poll or a briefly lagging API does not create a hole.
- On a `200` the `since` window moves forward and the next request is unconditional once; on a quiet poll the same URL and ETag produce `304`, which does not count against the primary rate limit.
- A baseline poll starts from now and discards the items it sees.

## Branch CI

Notifications only say `ci_activity` and cannot tell pass from fail or name the branch. `github.ci.failed` comes from the Actions runs API.

```sh
gh api -i --hostname github.com \
  "/repos/owner/repo/actions/runs?status=completed&per_page=100&sort=updated&direction=desc" \
  -H "Accept: application/vnd.github+json" \
  -H 'If-None-Match: W/"..."'
```

- Failure-like conclusions: `failure`, `timed_out`, `action_required`, `startup_failure`. A cancelled, skipped, neutral or successful run emits nothing.
- Payload: `host`, `repo`, `branch`, `workflow`, `conclusion`, `event`, `runId`, `attempt`, `url`, `updatedAt`. The branch is `head_branch`. A push run on the default branch has `event: "push"` and `branch: "main"` (or whatever the default is); a pull-request run has `event: "pull_request"` and the head branch.
- Dedupe is by `runId:attempt`, so a re-run is a new event.
- A baseline poll starts from now and records the current runs without emitting.

## Wildcards and cost

- An exact subscription (`owner/repo`) polls that one repository.
- `owner/*` resolves the owner through `/orgs/{owner}/repos`, falling back to `/users/{owner}/repos`, and caches the list for ten minutes. The cap is 100 repositories per owner.
- Each wanted repository costs two requests per interval at most: issues and Actions runs. Conditional `304` responses do not count against the primary rate limit. A large wildcard is still more expensive than a few exact subscriptions; prefer exact repositories when you can.

## What was verified

Beyond the notification checks above, against public repositories on `github.com` with `gh 2.101.0`:

- `GET /repos/.../issues` returned `200` with `ETag` and `Cache-Control: private, max-age=60`; the same request with the ETag returned `304`.
- `GET /repos/.../actions/runs?status=completed` returned `200` with `ETag`; the same request with the ETag returned `304`. Runs included `head_branch`, `conclusion` and `event`.
- `/orgs/owner/repos` returned `200` for an organisation and `404` for a user, where `/users/owner/repos` returned `200`.

## Limits to document for users

- Notifications only cover subscribed, watched or participating threads.
- Created items and CI are polled per subscribed repository, not per notification.
- CI notifications depend on the user's notification settings; `github.ci.failed` does not.
- Latency is up to one poll interval, about a minute by default.
- One page of 50 notifications per host per poll. A larger notification backlog is reported as `truncated` rather than silently paginated in a loop. Created and CI pages are up to 100 items and also report `truncated`.
- Auth failures pause that host; `doctor` says which one.
