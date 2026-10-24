import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { expect, test, vi } from "vitest";
import { terminalSnapshot } from "../../../src/terminal-host/terminal-snapshot";

const write = (terminal: Terminal, data: string) =>
  new Promise<void>((resolve) => {
    terminal.write(data, resolve);
  });
function lines(terminal: Terminal) {
  return Array.from({ length: terminal.rows }, (_, index) =>
    terminal.buffer.active.getLine(terminal.buffer.active.baseY + index)?.translateToString(true),
  );
}

test.each([false, true])(
  "restores both buffers, scrolling margins and origin (%s)",
  async (origin) => {
    const host = new Terminal({ cols: 20, rows: 8, allowProposedApi: true });
    const view = new Terminal({ cols: 20, rows: 8, allowProposedApi: true });
    const addon = new SerializeAddon();
    host.loadAddon(addon);
    try {
      await write(host, "\x1b[HNORMAL\x1b[7;1HEND\x1b[2;6r\x1b[6;1Hnormal bottom");
      for (const alternate of [false, true, false, true]) {
        if (alternate)
          await write(
            host,
            "\x1b[?1049h\x1b[2J\x1b[HHEADER\x1b[6;1HFOOTER\x1b[2;5r\x1b[5;1Hbottom",
          );
        else await write(host, "\x1b[?1049l");
        if (origin) await write(host, "\x1b[?6h\x1b[3;4H");
        for (let cycle = 0; cycle < 3; cycle++) {
          view.reset();
          await write(view, terminalSnapshot(host, addon));
          expect(lines(view)).toEqual(lines(host));
          expect(view.buffer.active.cursorX).toBe(host.buffer.active.cursorX);
          expect(view.buffer.active.cursorY).toBe(host.buffer.active.cursorY);
          expect(view.modes.originMode).toBe(host.modes.originMode);
          for (const data of ["\r\nNEXT", "\r\nAGAIN", "\x1b[1;1H\x1bMUP"]) {
            await write(host, data);
            await write(view, data);
            expect(lines(view)).toEqual(lines(host));
          }
        }
        if (alternate) {
          await write(host, "\x1b[?6l\x1b[?1049l\r\nNORMAL NEXT");
          await write(view, "\x1b[?6l\x1b[?1049l\r\nNORMAL NEXT");
          expect(lines(view)).toEqual(lines(host));
        }
      }
      // Resize and reset use xterm's current margins, not stale parsed sequences.
      host.resize(20, 10);
      view.resize(20, 10);
      await write(host, "\x1b[!p\x1b[HRESET");
      view.reset();
      await write(view, terminalSnapshot(host, addon));
      expect(lines(view)).toEqual(lines(host));
    } finally {
      host.dispose();
      view.dispose();
    }
  },
);

test.each([false, true])(
  "bounded history retains both visible buffers and state (alternate=%s)",
  async (alternate) => {
    const host = new Terminal({ cols: 20, rows: 8, allowProposedApi: true });
    const view = new Terminal({ cols: 20, rows: 8, allowProposedApi: true });
    const addon = new SerializeAddon();
    host.loadAddon(addon);
    try {
      await write(host, Array.from({ length: 100 }, (_, i) => `line ${String(i)}\r\n`).join(""));
      if (alternate) await write(host, "\x1b[?1049hALT\x1b[2;6r\x1b[?6h\x1b[3;2H");
      const before = host.buffer.normal.baseY;
      const data = terminalSnapshot(host, addon, (data) => data.length < 600);
      expect(data.length).toBeLessThan(600);
      expect(host.buffer.normal.baseY).toBe(before);
      await write(view, data);
      expect(view.buffer.normal.baseY).toBe(0);
      expect(lines(view)).toEqual(lines(host));
      expect(view.buffer.active.cursorX).toBe(host.buffer.active.cursorX);
      expect(view.buffer.active.cursorY).toBe(host.buffer.active.cursorY);
      expect(view.modes.originMode).toBe(host.modes.originMode);
      await write(host, "\x1b[?1049l");
      await write(view, "\x1b[?1049l");
      expect(lines(view)).toEqual(lines(host));
      expect(() => terminalSnapshot(host, addon, () => false)).toThrow("Visible terminal");
    } finally {
      host.dispose();
      view.dispose();
    }
  },
);

test("fails explicitly if the pinned xterm margin representation changes", () => {
  const host = new Terminal({ cols: 20, rows: 8, allowProposedApi: true });
  const addon = new SerializeAddon();
  host.loadAddon(addon);
  // Keep the real serializer out of this compatibility-guard test.
  const serialize = { serialize: () => "" };
  const buffer = host.buffer.active;
  vi.spyOn(host.buffer, "active", "get").mockReturnValue(buffer);
  for (const value of [
    undefined,
    null,
    {},
    { scrollTop: 0 },
    { scrollTop: "0", scrollBottom: 7 },
    { scrollTop: 0, scrollBottom: "7" },
    { scrollTop: 0.5, scrollBottom: 7 },
    { scrollTop: 0, scrollBottom: 7.5 },
    { scrollTop: -1, scrollBottom: 7 },
    { scrollTop: 0, scrollBottom: 8 },
    { scrollTop: 7, scrollBottom: 7 },
  ]) {
    Object.defineProperty(buffer, "_buffer", { value, configurable: true });
    expect(() => terminalSnapshot(host, Object.assign(addon, serialize))).toThrow(
      "scrolling-region",
    );
  }
  Reflect.deleteProperty(buffer, "_buffer");
  expect(() => terminalSnapshot(host, addon)).toThrow("scrolling-region");
  host.dispose();
});

for (const alternate of [false, true]) {
  for (const origin of [false, true]) {
    for (const bottom of [false, true]) {
      test(`preserves pending wrap: alternate=${String(alternate)}, origin=${String(origin)}, bottom=${String(bottom)}`, async () => {
        const host = new Terminal({ cols: 10, rows: 6, allowProposedApi: true });
        const view = new Terminal({ cols: 10, rows: 6, allowProposedApi: true });
        const addon = new SerializeAddon();
        host.loadAddon(addon);
        try {
          await write(
            host,
            `${alternate ? "\x1b[?1049h" : ""}\x1b[HHEADER\x1b[6;1HFOOTER\x1b[2;5r${origin ? "\x1b[?6h" : ""}\x1b[${String((bottom ? 5 : 3) - (origin ? 1 : 0))};1H0123456789`,
          );
          expect(host.buffer.active.cursorX).toBe(10);
          await write(view, terminalSnapshot(host, addon));
          expect(lines(view)).toEqual(lines(host));
          expect(view.buffer.active.cursorX).toBe(10);
          expect(view.buffer.active.cursorY).toBe(host.buffer.active.cursorY);
          expect(view.modes.originMode).toBe(origin);
          for (const data of ["X", "123456789", "Y", "\r\nNEXT"]) {
            await write(host, data);
            await write(view, data);
            expect(lines(view)).toEqual(lines(host));
            expect(view.buffer.active.cursorX).toBe(host.buffer.active.cursorX);
            expect(view.buffer.active.cursorY).toBe(host.buffer.active.cursorY);
          }
        } finally {
          host.dispose();
          view.dispose();
        }
      });
    }
  }
}

test.each([false, true])(
  "pending wrap preserves styled wide cells and the pen (alternate=%s)",
  async (alternate) => {
    const host = new Terminal({ cols: 10, rows: 6, allowProposedApi: true });
    const view = new Terminal({ cols: 10, rows: 6, allowProposedApi: true });
    const addon = new SerializeAddon();
    host.loadAddon(addon);
    try {
      // Leave the normal buffer pending too, before saving it on alternate entry.
      await write(host, "\x1b[2;5r\x1b[3;1H0123456789");
      if (alternate) await write(host, "\x1b[?1049h");
      await write(host, "\x1b[2;5r\x1b[5;1H\x1b[31;44;1m12  5678界\x1b[0;32m\x1b[4h");
      await write(view, terminalSnapshot(host, addon));
      const cells = (terminal: Terminal) =>
        Array.from({ length: terminal.rows }, (_, y) =>
          Array.from({ length: terminal.cols }, (_, x) => {
            const cell = terminal.buffer.active
              .getLine(terminal.buffer.active.baseY + y)
              ?.getCell(x);
            return [
              cell?.getChars(),
              cell?.getWidth(),
              cell?.getFgColor(),
              cell?.getBgColor(),
              cell?.isBold(),
            ];
          }),
        );
      expect(cells(view)).toEqual(cells(host));
      expect(view.buffer.active.cursorX).toBe(10);
      expect(view.modes.insertMode).toBe(true);
      for (const data of ["X", "\x1b[2;1Hinsert", "\x1b[?1049l\x1b[0m", "NORMAL"]) {
        await write(host, data);
        await write(view, data);
        expect(cells(view)).toEqual(cells(host));
        expect(view.buffer.active.cursorX).toBe(host.buffer.active.cursorX);
        expect(view.buffer.active.cursorY).toBe(host.buffer.active.cursorY);
      }
    } finally {
      host.dispose();
      view.dispose();
    }
  },
);

test("rejects incompatible pinned row serializers when restoring pending wrap", async () => {
  const host = new Terminal({ cols: 10, rows: 6, allowProposedApi: true });
  const addon = new SerializeAddon();
  host.loadAddon(addon);
  try {
    await write(host, "\x1b[2;5r\x1b[3;1H0123456789");
    // Bypass the public serializer, which also uses the internal method under test.
    vi.spyOn(addon, "serialize").mockReturnValue("");
    Object.defineProperty(addon, "_serializeBufferByRange", {
      value: undefined,
      configurable: true,
    });
    expect(() => terminalSnapshot(host, addon)).toThrow("row serializer");
    Object.defineProperty(addon, "_serializeBufferByRange", { value: () => null });
    expect(() => terminalSnapshot(host, addon)).toThrow("row serialization");
  } finally {
    host.dispose();
  }
});

test.each([false, true])(
  "restores cursor defaults and application styles (alternate=%s)",
  async (alternate) => {
    const host = new Terminal({ cursorBlink: true, allowProposedApi: true });
    const view = new Terminal({ cursorBlink: false, allowProposedApi: true });
    const addon = new SerializeAddon();
    const viewAddon = new SerializeAddon();
    host.loadAddon(addon);
    view.loadAddon(viewAddon);
    try {
      if (alternate) await write(host, "\x1b[?1049h");
      for (const [data, expected] of [
        ["", "\x1b[?12h\x1b[0 q"],
        ["\x1b[?12l", "\x1b[?12l\x1b[0 q"],
        ["\x1b[?12h", "\x1b[?12h\x1b[0 q"],
        ["\x1b[1 q", "\x1b[?12h\x1b[1 q"],
        ["\x1b[2 q", "\x1b[?12h\x1b[2 q"],
        ["\x1b[3 q", "\x1b[?12h\x1b[3 q"],
        ["\x1b[4 q", "\x1b[?12h\x1b[4 q"],
        ["\x1b[5 q", "\x1b[?12h\x1b[5 q"],
        ["\x1b[6 q", "\x1b[?12h\x1b[6 q"],
        ["\x1b[?12l", "\x1b[?12l\x1b[6 q"],
        ["\x1b[0 q", "\x1b[?12l\x1b[0 q"],
        ["\x1b[?12h", "\x1b[?12h\x1b[0 q"],
        ["\x1bc", "\x1b[?12h\x1b[0 q"],
      ]) {
        await write(host, data ?? "");
        const snapshot = terminalSnapshot(host, addon);
        expect(snapshot.endsWith(expected ?? "")).toBe(true);
        for (let cycle = 0; cycle < 2; cycle++) {
          view.reset();
          await write(view, snapshot);
          expect(view.options.cursorBlink).toBe(host.options.cursorBlink);
          expect(terminalSnapshot(view, viewAddon).endsWith(expected ?? "")).toBe(true);
        }
      }
    } finally {
      host.dispose();
      view.dispose();
    }
  },
);

test("rejects incompatible pinned cursor state", () => {
  const host = new Terminal();
  const addon = new SerializeAddon();
  host.loadAddon(addon);
  const original = Object.getOwnPropertyDescriptor(host, "_core");
  try {
    for (const value of [
      undefined,
      null,
      {},
      { coreService: null },
      { coreService: {} },
      { coreService: { decPrivateModes: {} } },
      { coreService: { decPrivateModes: { cursorBlink: "yes", cursorStyle: undefined } } },
      { coreService: { decPrivateModes: { cursorBlink: undefined, cursorStyle: "beam" } } },
    ]) {
      Object.defineProperty(host, "_core", { value, configurable: true });
      expect(() => terminalSnapshot(host, addon)).toThrow("cursor state");
    }
  } finally {
    if (original) Object.defineProperty(host, "_core", original);
    host.dispose();
  }
});
