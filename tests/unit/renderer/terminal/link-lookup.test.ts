import { Terminal } from "@xterm/headless";
import { afterEach, expect, test } from "vitest";
import { linksOnRow } from "../../../../src/renderer/terminal/link-lookup";
import { TERMINAL_LINK_LIMIT } from "../../../../src/shared/terminal-link";

const terminals: Terminal[] = [];
async function fixture(output: string, cols = 40, rows = 24) {
  const terminal = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true });
  terminals.push(terminal);
  await new Promise<void>((resolve) => {
    terminal.write(output, resolve);
  });
  return terminal;
}
const osc = (target: string, text: string) => `\x1b]8;;${target}\x1b\\${text}\x1b]8;;\x1b\\`;
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

test("pinned xterm OSC targets are complete on every soft-wrapped row and label comparison is exact", async () => {
  const url = "https://login.example/oauth?state=" + "X".repeat(2100);
  const terminal = await fixture(osc(url, url), 80, 40);
  const first = linksOnRow(terminal, 0)[0];
  expect(first?.url).toBe(url);
  expect(first?.text).toBe(url);
  expect(first?.rows.length).toBeGreaterThan(20);
  for (const row of first?.rows ?? []) expect(linksOnRow(terminal, row.y)).toEqual([first]);
  const labeled = await fixture(osc(url, "Sign in"));
  expect(linksOnRow(labeled, 0)[0]).toMatchObject({ url, text: "Sign in" });
});

test("OSC labels with hard newlines retain them and all rows keep the complete target", async () => {
  const url = "https://example.com/one/two/three";
  const terminal = await fixture(osc(url, "https://example.com/\r\none/two/three"));
  const first = linksOnRow(terminal, 0)[0];
  expect(first).toMatchObject({
    url,
    text: "https://example.com/\none/two/three",
    rows: [
      { y: 0, start: 0, end: 20 },
      { y: 1, start: 0, end: 13 },
    ],
  });
  expect(linksOnRow(terminal, 1)).toEqual([first]);
});

test("plain URLs join soft wraps, preserve UTF-16/cell coordinates and trim surrounding punctuation", async () => {
  const url = "https://example.com/" + "q".repeat(120);
  const terminal = await fixture(`中e\u0301 (${url}).`, 40);
  const first = linksOnRow(terminal, 0)[0];
  expect(first?.url).toBe(url);
  expect(first?.text).toBe(url);
  expect(first?.rows[0]?.start).toBe(5);
  for (const row of first?.rows ?? []) expect(linksOnRow(terminal, row.y)).toEqual([first]);
  const punctuation = await fixture("https://example.com/a(b) https://other.test/path!?", 80);
  expect(linksOnRow(punctuation, 0).map((link) => link.url)).toEqual([
    "https://example.com/a(b)",
    "https://other.test/path",
  ]);
  expect(linksOnRow(terminal, 999)).toEqual([]);
});

test("hard-wrapped plain URLs never join or infer a continuation", async () => {
  const terminal = await fixture(
    "https://login.example/oauth?\r\nstate=abc\r\nhttps://other.example/next",
  );
  expect(linksOnRow(terminal, 0).map((link) => link.url)).toEqual(["https://login.example/oauth"]);
  expect(linksOnRow(terminal, 1)).toEqual([]);
  expect(linksOnRow(terminal, 2).map((link) => link.url)).toEqual(["https://other.example/next"]);
});

test("refused OSC links never fall back to their displayed plain URL", async () => {
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://example.com/" + "x".repeat(TERMINAL_LINK_LIMIT),
  ]) {
    const terminal = await fixture(osc(url, "https://safe.example/"));
    expect(linksOnRow(terminal, 0)).toEqual([]);
  }
  const terminal = await fixture(
    "https://example.com/" + "x".repeat(TERMINAL_LINK_LIMIT + 100),
    80,
    250,
  );
  expect(linksOnRow(terminal, 0)).toEqual([]);
  expect(linksOnRow(terminal, 240)).toEqual([]);
});

test("incomplete or disjoint OSC labels require confirmation, never a partial match", async () => {
  const long = await fixture(
    osc("https://example.com/", "a".repeat(TERMINAL_LINK_LIMIT + 500)),
    80,
    250,
  );
  expect(linksOnRow(long, 0)[0]?.text).toBeUndefined();
  expect(linksOnRow(long, 220)[0]?.text).toBeUndefined();
  const reused = await fixture(
    "\x1b]8;id=same;https://example.com/\x1b\\https://\x1b]8;;\x1b\\ \x1b]8;id=same;https://example.com/\x1b\\example.com/\x1b]8;;\x1b\\",
  );
  expect(linksOnRow(reused, 0)[0]?.text).toBeUndefined();
});

test("an unavailable OSC service refuses its target without plain fallback", async () => {
  const terminal = await fixture(osc("https://example.com/", "https://example.com/"));
  // Only the public buffer is supplied: OSC IDs remain, but target authority is absent.
  expect(linksOnRow({ buffer: terminal.buffer, cols: terminal.cols }, 0)).toEqual([]);
});

test("concealed OSC and plain targets never qualify as fully displayed matching text", async () => {
  const url = "https://concealed.example/path";
  for (const output of [osc(url, `\x1b[8m${url}\x1b[0m`), `\x1b[8m${url}\x1b[0m`]) {
    const terminal = await fixture(output);
    expect(linksOnRow(terminal, 0)[0]).toMatchObject({ url, text: undefined });
  }
});
