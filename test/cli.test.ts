import { describe, expect, test } from "bun:test";
import { main } from "../src/main.ts";
import { mcpSnippet } from "../src/commands/setup.ts";
import { DEFAULT_PORT } from "../src/config/config.ts";

describe("CLI", () => {
  test("--help and version succeed", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(await main(["version"])).toBe(0);
    expect(await main(["version", "--short"])).toBe(0);
  });

  test("an unknown command exits 2", async () => {
    expect(await main(["nonsense"])).toBe(2);
  });

  test("a command without its argument exits non-zero", async () => {
    expect(await main(["subscribe"])).toBe(1);
    expect(await main(["unsubscribe"])).toBe(1);
  });

  test("the snippet has the URL, bearer token and protocol", () => {
    const snippet = JSON.parse(mcpSnippet(DEFAULT_PORT, "abc"));
    expect(snippet.mcp["github-events"].url).toBe(`http://127.0.0.1:${DEFAULT_PORT}/mcp`);
    expect(snippet.mcp["github-events"].headers.Authorization).toBe("Bearer abc");
    expect(snippet.mcp["github-events"].protocol).toBe("2026-07-28");
  });

  test("build configurations do not hide the Windows console so CLI output is visible", async () => {
    const pkg = await Bun.file("package.json").json();
    expect(pkg.scripts.build).not.toContain("--windows-hide-console");

    const ci = await Bun.file(".github/workflows/ci.yml").text();
    expect(ci).not.toContain("--windows-hide-console");

    const release = await Bun.file(".github/workflows/release.yml").text();
    expect(release).not.toContain("--windows-hide-console");
  });
});
