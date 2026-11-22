# Install

## mise (recommended once a release exists)

```sh
mise use -g github:t128n/github-events-mcp@0.1.0
github-events-mcp version
```

Or follow the latest release:

```sh
mise install github:t128n/github-events-mcp@latest
```

mise hides very new releases for its `minimum_release_age` setting (24 hours by default). If `mise ls-remote` says the release is hidden, either wait, or opt out for this install:

```sh
MISE_MINIMUM_RELEASE_AGE=0 mise install github:t128n/github-events-mcp@0.1.0
```

The GitHub release attaches one file, `github-events-mcp-windows-x64.exe`. mise detects the `windows` and `x64` part, downloads it, and puts it on `PATH` as `github-events-mcp`. The tool is Windows-only; a mise install on macOS or Linux has no matching release asset.

If mise ever picks the checksum file or the wrong asset:

```sh
mise use -g 'github:t128n/github-events-mcp@0.1.0[asset_pattern=github-events-mcp-windows-x64.exe]'
```

## Direct download

Download `github-events-mcp-windows-x64.exe` and `SHA256SUMS` from the release, verify with `sha256sum -c SHA256SUMS` (or `certutil -hashfile` on Windows), then rename the exe to `github-events-mcp.exe` if you want the command name without the suffix.

## After installing

```sh
github-events-mcp setup
github-events-mcp doctor
github-events-mcp install
```

`setup` prints the MCP client snippet. `install` registers the per-user logon task. The manual Windows pass is in [`windows-checklist.md`](windows-checklist.md).
