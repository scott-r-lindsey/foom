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

test("pinned xterm OSC targets are complete on every soft-wrapped row", async () => {
  const url = "https://login.example/oauth?state=" + "X".repeat(2100);
  const terminal = await fixture(osc(url, url), 80, 40);
  const first = linksOnRow(terminal, 0)[0];
  expect(first?.url).toBe(url);
  expect(first?.rows.length).toBeGreaterThan(20);
  for (const row of first?.rows ?? []) expect(linksOnRow(terminal, row.y)).toEqual([first]);
  const labeled = await fixture(osc(url, "Sign in"));
  expect(linksOnRow(labeled, 0)[0]).toMatchObject({ url });
});

test("OSC labels with hard newlines keep the complete target on every row", async () => {
  const url = "https://example.com/one/two/three";
  const terminal = await fixture(osc(url, "https://example.com/\r\none/two/three"));
  const first = linksOnRow(terminal, 0)[0];
  expect(first).toMatchObject({
    url,
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

test("an unavailable OSC service refuses its target without plain fallback", async () => {
  const terminal = await fixture(osc("https://example.com/", "https://example.com/"));
  // Only the public buffer is supplied: OSC IDs remain, but target authority is absent.
  expect(linksOnRow({ buffer: terminal.buffer, cols: terminal.cols }, 0)).toEqual([]);
});

test("canonical ASCII OAuth URL preserves percent escapes and ampersands across soft wraps", async () => {
  const url =
    "https://login.example/oauth?redirect_uri=https%3A%2F%2Fapp.example%2Fcallback&scope=openid%20profile&state=" +
    "x".repeat(2100);
  for (const output of [url, osc(url, url)]) {
    const terminal = await fixture(output, 80, 40);
    for (let row = 0; row < 20; row++) expect(linksOnRow(terminal, row)[0]).toMatchObject({ url });
  }
});

test("BEL-terminated OSC links stay distinct from printf echo at every chunk boundary", async () => {
  const url = "https://remote.example.test/oauth?state=fixture";
  const echo = String.raw`printf '\033]8;;${url}\007Remote sign in\033]8;;\007\n'`;
  const output = `\x1b]8;;${url}\x07Remote sign in\x1b]8;;\x07`;
  for (let split = 1; split < output.length; split++) {
    const terminal = await fixture(`${echo}\r\n`, 160);
    const write = (data: string) =>
      new Promise<void>((resolve) => {
        terminal.write(data, resolve);
      });
    await write(output.slice(0, split));
    await write(output.slice(split));
    expect(linksOnRow(terminal, 0).map((link) => link.url)).toEqual([String.raw`${url}\007Remote`]);
    expect(linksOnRow(terminal, 1)).toEqual([
      { url, rows: [{ y: 1, start: 0, end: "Remote sign in".length }] },
    ]);
  }
});
