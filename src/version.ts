export const VERSION = "0.2.1";
export const NAME = "github-events-mcp";

/** Numeric comparison for `1.2.3` (an optional leading `v` and a `-suffix` are tolerated). */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .trim()
      .replace(/^v/i, "")
      .split("-")[0]!
      .split(".")
      .map((part) => Number(part.replace(/\D.*$/, "")) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}
