import { Terminal } from "@xterm/headless";
import { expect, test, vi } from "vitest";
import { TerminalColors } from "../../../src/shared/terminal-colors";
const osc = (code: number, data = "") => `\x1b]${String(code)};${data}\x1b\\`;

test("color ownership includes mixed palette queries, XParseColor formats, resets and theme defaults", async () => {
  const screen = new Terminal({ allowProposedApi: true });
  const reply = vi.fn<(data: string) => void>();
  const changed = vi.fn();
  const colors = new TerminalColors(screen.parser, false, reply, changed);
  const write = (text: string) =>
    new Promise<void>((resolve) => {
      screen.write(text, resolve);
    });
  try {
    await write(osc(10, "?;?;?;?"));
    expect(reply.mock.calls.map(([data]) => data)).toEqual([
      osc(10, "rgb:1414/1010/1f1f"),
      osc(11, "rgb:f3f3/f0f0/fafa"),
      osc(12, "rgb:5b5b/2b2b/d9d9"),
    ]);
    for (const [value, expected] of [
      ["#abc", "#a0b0c0"],
      ["#123456", "#123456"],
      ["#123456789", "#124578"],
      ["#123456789abc", "#12569a"],
      ["RGB:f/0/8", "#ff0088"],
      ["rgb:ff/80/00", "#ff8000"],
      ["rgb:fff/800/000", "#ff8000"],
      ["rgb:ffff/8000/0000", "#ff8000"],
    ]) {
      await write(osc(11, value));
      expect(colors.theme().background).toBe(expected);
    }
    for (const invalid of ["red", "#12", "#ggg", "rgb:f/00/a", "rgb:/a/b", ""]) {
      await write(osc(11, invalid));
      expect(colors.theme().background).toBe("#ff8000");
    }
    reply.mockClear();
    await write(osc(4, "0;#112233;0;?;255;?;256;?;-1;?;bad;?;4") + osc(104, "-1;bad;256;0;"));
    expect(reply.mock.calls.map(([data]) => data)).toEqual([
      osc(4, "0;rgb:1111/2222/3333"),
      osc(4, "255;rgb:eeee/eeee/eeee"),
    ]);
    expect(colors.theme().black).toBe("#2e3436");
    await write(osc(4, "16;#112233;255;#123456") + osc(10, "#112233;#445566;#778899"));
    expect(colors.theme()).toMatchObject({
      foreground: "#112233",
      background: "#445566",
      cursor: "#778899",
    });
    const snapshot = colors.snapshot();
    colors.reset(true);
    expect(colors.theme()).toMatchObject({
      foreground: "#f4efff",
      background: "#05040a",
      cursor: "#9b6bff",
    });
    await write(snapshot);
    expect(colors.theme().extendedAnsi?.[0]).toBe("#112233");
    await write(osc(104) + osc(110) + osc(111) + osc(112));
    expect(colors.theme()).toMatchObject({
      foreground: "#f4efff",
      background: "#05040a",
      cursor: "#9b6bff",
    });
    expect(colors.theme().extendedAnsi?.[0]).toBe("#000000");
    expect(colors.theme().extendedAnsi?.[239]).toBe("#eeeeee");
    expect(changed).toHaveBeenCalled();
  } finally {
    screen.dispose();
  }
});

test("views consume color queries without replies, preserve changes and ordinary input across reset", async () => {
  const screen = new Terminal({ allowProposedApi: true });
  const input = vi.fn();
  screen.onData(input);
  const colors = new TerminalColors(screen.parser, false, () => {});
  try {
    for (const reset of [false, true]) {
      if (reset) screen.reset();
      await new Promise<void>((resolve) => {
        screen.write(osc(4, "0;#112233;0;?") + osc(10, "?;?;?") + "visible", resolve);
      });
      expect(colors.theme().black).toBe("#112233");
      expect(input).not.toHaveBeenCalled();
    }
    for (const data of ["typed", "pasted\ntext", "\x1b[<0;1;1M", osc(11, "rgb:ffff/ffff/ffff")]) {
      screen.input(data, true);
      expect(input).toHaveBeenLastCalledWith(data);
    }
  } finally {
    screen.dispose();
  }
});

test("chosen palettes answer OSC queries and restore their own ANSI defaults", async () => {
  const { terminalThemes } = await import("../../../src/shared/terminal-themes");
  const screen = new Terminal({ allowProposedApi: true });
  const reply = vi.fn();
  const theme = terminalThemes.dracula;
  const colors = new TerminalColors(screen.parser, theme, reply);
  const write = (data: string) =>
    new Promise<void>((resolve) => {
      screen.write(data, resolve);
    });
  try {
    await write(osc(10, "?") + osc(11, "?") + osc(4, "1;?"));
    expect(reply.mock.calls).toEqual([
      [osc(10, "rgb:f8f8/f8f8/f2f2")],
      [osc(11, "rgb:2828/2a2a/3636")],
      [osc(4, "1;rgb:ffff/5555/5555")],
    ]);
    await write(osc(4, "1;#000000") + osc(104));
    expect(colors.theme()).toMatchObject(theme);
    colors.reset({ ...theme, foreground: "#ABCDEF" });
    await write(osc(10, "?"));
    expect(reply).toHaveBeenLastCalledWith(osc(10, "rgb:abab/cdcd/efef"));
  } finally {
    screen.dispose();
  }
});
