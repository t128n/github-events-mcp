export interface HttpExchange {
  status: number;
  reason: string;
  /** Header names are lower-cased. Repeated headers are joined with ", ". */
  headers: Record<string, string>;
  body: string;
}

/**
 * Splits the stdout of `gh api -i` (or any HTTP text exchange) into status, headers and body.
 * `gh` may emit several status blocks when it follows a redirect; the last one is the answer.
 * On a 304 the body is empty and `gh` exits 1, which the caller decides what to do with.
 */
export function parseHttpExchange(text: string): HttpExchange {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^HTTP\/\d(?:\.\d)?\s+\d{3}/.test(line)) {
      if (current.length) blocks.push(current);
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);
  const block = blocks[blocks.length - 1];
  if (!block) return { status: 0, reason: "", headers: {}, body: text };
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/.exec(block[0]!)!;
  const headers: Record<string, string> = {};
  let index = 1;
  for (; index < block.length; index++) {
    const line = block[index]!;
    if (line === "") break;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  const body = block.slice(index + 1).join("\n").replace(/\n$/, "");
  return { status: Number(statusMatch[1]), reason: statusMatch[2] ?? "", headers, body };
}

export const header = (exchange: HttpExchange, name: string): string | undefined => exchange.headers[name.toLowerCase()];

export function headerNumber(exchange: HttpExchange, name: string): number | undefined {
  const value = header(exchange, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
