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

test.each([false, true])(
  "bounded replay preserves blank-cell backgrounds in both buffers (alternate=%s)",
  async (alternate) => {
    const host = new Terminal({ cols: 20, rows: 8, allowProposedApi: true });
    const view = new Terminal({ cols: 20, rows: 8, allowProposedApi: true });
    const addon = new SerializeAddon();
    host.loadAddon(addon);
    const cells = (terminal: Terminal) =>
      Array.from({ length: terminal.rows }, (_, row) =>
        Array.from({ length: terminal.cols }, (_, col) => {
          const cell = terminal.buffer.active
            .getLine(terminal.buffer.active.baseY + row)
            ?.getCell(col);
          return [cell?.getChars(), cell?.getBgColorMode(), cell?.getBgColor()];
        }),
      );
    try {
      await write(host, "\x1b[41m" + "red\r\n".repeat(40));
      await write(
        host,
        "\x1b[48;2;245;244;243m\x1b[2J\x1b[HNORMAL\x1b[3;4H\x1b[44m\x1b[5X\x1b[31;42m",
      );
      if (alternate)
        await write(
          host,
          "\x1b[?1049h\x1b[41m\x1b[2J\x1b[HALT\x1b[4;5H\x1b[48;2;245;244;243m\x1b[7X\x1b[31;42m",
        );
      await write(
        host,
        "\x1b[2;8H\x1b[49m\x1b[2X\x1b[3;1H\x1b[48;5;200m\x1b[2X\x1b[3;3H\x1b[103m\x1b[2X\x1b[3;5H界\x1b[31;42m",
      );
      const history = host.buffer.normal.baseY;
      // Force the real serializer down its bounded, zero-scrollback path.
      let attempts = 0;
      const data = terminalSnapshot(host, addon, () => ++attempts > 1);
      expect(attempts).toBe(2);
      expect(host.buffer.normal.baseY).toBe(history);
      await write(view, data);
      expect(view.buffer.normal.baseY).toBe(0);
      expect(cells(view)).toEqual(cells(host));
      expect(view.buffer.active.cursorX).toBe(host.buffer.active.cursorX);
      expect(view.buffer.active.cursorY).toBe(host.buffer.active.cursorY);
      expect(view.modes).toEqual(host.modes);
      // Subsequent erasure checks the restored current pen as well as cells.
      for (const data of ["\x1b[X", "\x1b[?1049l", "\x1b[X"]) {
        await write(host, data);
        await write(view, data);
        expect(cells(view)).toEqual(cells(host));
        expect(view.buffer.active.cursorX).toBe(host.buffer.active.cursorX);
        expect(view.buffer.active.cursorY).toBe(host.buffer.active.cursorY);
      }
      expect(host.buffer.normal.baseY).toBe(history);
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

test.each([
  { alternate: false, bounded: false },
  { alternate: true, bounded: false },
  { alternate: false, bounded: true },
  { alternate: true, bounded: true },
])(
  "pending wrap preserves styled wide cells and the pen ($alternate, bounded=$bounded)",
  async ({ alternate, bounded }) => {
    const host = new Terminal({ cols: 10, rows: 6, allowProposedApi: true });
    const view = new Terminal({ cols: 10, rows: 6, allowProposedApi: true });
    const addon = new SerializeAddon();
    host.loadAddon(addon);
    try {
      // Leave the normal buffer pending too, before saving it on alternate entry.
      await write(host, "\x1b[2;5r\x1b[3;1H0123456789");
      if (alternate) await write(host, "\x1b[?1049h");
      await write(host, "\x1b[2;5r\x1b[5;1H\x1b[31;44;1m12  5678界\x1b[0;32m\x1b[4h");
      let attempts = 0;
      await write(view, terminalSnapshot(host, addon, bounded ? () => ++attempts > 1 : undefined));
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
      writable: true,
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

test.each([false, true])(
  "restores default and application cursor visibility in a reused view (alternate=%s)",
  async (alternate) => {
    const host = new Terminal({ cursorBlink: true, allowProposedApi: true });
    const view = new Terminal({ cursorBlink: true, allowProposedApi: true });
    const addon = new SerializeAddon();
    host.loadAddon(addon);
    try {
      if (alternate) await write(host, "\x1b[?1049h");
      for (const [data, hidden] of [
        ["", false],
        ["\x1b[?25l", true],
        ["\x1b[?25h", false],
      ] as const) {
        await write(host, data);
        await write(view, hidden ? "\x1b[?25h" : "\x1b[?25l");
        view.reset();
        await write(view, terminalSnapshot(host, addon));
        let reply = "";
        const subscription = view.onData((data) => {
          reply += data;
        });
        try {
          await write(view, "\x1b[?25$p");
          expect(reply).toBe(`\x1b[?25;${hidden ? "2" : "1"}$y`);
        } finally {
          subscription.dispose();
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
      {
        coreService: {
          isCursorHidden: "yes",
          decPrivateModes: { cursorBlink: undefined, cursorStyle: undefined },
        },
      },
      { coreService: { isCursorHidden: false, decPrivateModes: {} } },
      {
        coreService: {
          isCursorHidden: false,
          decPrivateModes: { cursorBlink: "yes", cursorStyle: undefined },
        },
      },
      {
        coreService: {
          isCursorHidden: false,
          decPrivateModes: { cursorBlink: undefined, cursorStyle: "beam" },
        },
      },
    ]) {
      Object.defineProperty(host, "_core", { value, configurable: true });
      expect(() => terminalSnapshot(host, addon)).toThrow("cursor state");
    }
  } finally {
    if (original) Object.defineProperty(host, "_core", original);
    host.dispose();
  }
});

test("replay retains OSC targets, normal/alternate history, label styles and an open live link pen", async () => {
  const { linksOnRow } = await import("../../../src/renderer/terminal/link-lookup");
  const { terminalOscId, terminalOscTarget } = await import("../../../src/shared/terminal-link");
  const host = new Terminal({ cols: 40, rows: 8, scrollback: 100, allowProposedApi: true });
  const view = new Terminal({ cols: 40, rows: 8, scrollback: 100, allowProposedApi: true });
  const addon = new SerializeAddon();
  host.loadAddon(addon);
  const url = "https://login.example/" + "x".repeat(2100);
  const osc = (target: string, text: string) => `\x1b]8;;${target}\x1b\\${text}\x1b]8;;\x1b\\`;
  try {
    await write(
      host,
      osc(url, "\x1b[1;31mSign in\x1b[0m") +
        "\r\nhttps://plain.example.test/path\r\n" +
        osc("file:///blocked", "https://displayed.test/") +
        "\r\n" +
        osc(url, "中" + "p".repeat(100)) +
        "\r\n",
    );
    for (const alternate of [false, true]) {
      if (alternate) await write(host, "\x1b[?1049h\x1b[H" + osc(url, "Alternate label"));
      view.reset();
      await write(view, terminalSnapshot(host, addon));
      expect(lines(view)).toEqual(lines(host));
      expect(linksOnRow(view, 0)[0]?.url).toBe(url);
      if (!alternate) {
        expect(view.buffer.normal.getLine(0)?.getCell(0)?.isBold()).toBeTruthy();
        expect(linksOnRow(view, 1)[0]?.url).toBe("https://plain.example.test/path");
        expect(linksOnRow(view, 2)).toEqual([]);
        expect(linksOnRow(view, 4)[0]?.url).toBe(url);
      }
    }
    await write(host, "\x1b]8;;https://live.example/\x1b\\Open");
    view.reset();
    await write(view, terminalSnapshot(host, addon));
    await write(host, " continued");
    await write(view, " continued");
    const cell = view.buffer.active
      .getLine(view.buffer.active.cursorY)
      ?.getCell(view.buffer.active.cursorX - 1);
    const id = terminalOscId(cell);
    expect(id && terminalOscTarget(view, id)).toBe("https://live.example/");
  } finally {
    host.dispose();
    view.dispose();
  }
});

test.each([260, 300])(
  "OSC replay retains the full budget and degrades excess targets without losing cells (%s links)",
  async (count) => {
    const { terminalOscId, terminalOscTarget } = await import("../../../src/shared/terminal-link");
    const host = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const view = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const addon = new SerializeAddon();
    host.loadAddon(addon);
    const targets = Array.from({ length: count }, (_, i) =>
      ("https://budget.test/" + String(i) + "/").padEnd(16000, "x"),
    );
    try {
      await write(host, targets.map((url) => `\x1b]8;;${url}\x1b\\x\x1b]8;;\x1b\\`).join(""));
      const snapshot = terminalSnapshot(host, addon);
      await write(view, snapshot);
      expect(lines(view)).toEqual(lines(host));
      const replayed = targets.map((_, i) => {
        const id = terminalOscId(view.buffer.active.getLine(Math.floor(i / 80))?.getCell(i % 80));
        return id && terminalOscTarget(view, id);
      });
      if (count === 260) expect(replayed).toEqual(targets);
      else {
        expect(replayed.slice(0, 80)).toContain("foom-refused:");
        expect(replayed.at(-1)).toBe(targets.at(-1));
        expect(snapshot.length).toBeLessThan(4 * 1024 * 1024 + 20000);
      }
      expect(addon.serialize()).not.toContain("\x1b]8;");
    } finally {
      host.dispose();
      view.dispose();
    }
  },
);

test("transport size fallback removes OSC targets without turning their labels into plain links", async () => {
  const { linksOnRow } = await import("../../../src/renderer/terminal/link-lookup");
  const host = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const view = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const addon = new SerializeAddon();
  host.loadAddon(addon);
  try {
    await write(
      host,
      `\x1b]8;;https://budget.test/${"x".repeat(16000)}\x1b\\https://safe.example/\x1b]8;;\x1b\\`,
    );
    const snapshot = terminalSnapshot(host, addon, (data) => data.length < 500);
    await write(view, snapshot);
    expect(lines(view)).toEqual(lines(host));
    expect(linksOnRow(view, 0)).toEqual([]);
    expect(snapshot.length).toBeLessThan(500);
  } finally {
    host.dispose();
    view.dispose();
  }
});

test("130 distinct one-cell 16000-character OSC targets cannot prevent visible-screen replay", async () => {
  const { terminalOscId, terminalOscTarget } = await import("../../../src/shared/terminal-link");
  const host = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const view = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const addon = new SerializeAddon();
  host.loadAddon(addon);
  const targets = Array.from({ length: 130 }, (_, i) =>
    ("https://budget.test/" + String(i) + "/").padEnd(16000, "x"),
  );
  try {
    await write(host, targets.map((url) => `\x1b]8;;${url}\x1b\\x\x1b]8;;\x1b\\`).join(""));
    await write(view, terminalSnapshot(host, addon));
    expect(lines(view)).toEqual(lines(host));
    for (let i = 0; i < targets.length; i++) {
      const cell = view.buffer.active.getLine(Math.floor(i / 80))?.getCell(i % 80);
      const id = terminalOscId(cell);
      expect(id && terminalOscTarget(view, id)).toBe(targets[i]);
    }
  } finally {
    host.dispose();
    view.dispose();
  }
});

test("over-budget replay keeps normal and alternate buffers aligned when target metadata degrades", async () => {
  const host = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const view = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const addon = new SerializeAddon();
  host.loadAddon(addon);
  const links = (label: string) =>
    Array.from(
      { length: 150 },
      (_, i) =>
        `\x1b]8;;${(`https://budget.test/${label}/${String(i)}/`).padEnd(16000, "x")}\x1b\\${label}\x1b]8;;\x1b\\`,
    ).join("");
  try {
    await write(host, links("n"));
    await write(host, "\x1b[?1049h" + links("a"));
    await write(view, terminalSnapshot(host, addon));
    expect(view.buffer.active.type).toBe("alternate");
    expect(lines(view)).toEqual(lines(host));
    await write(host, "\x1b[?1049l");
    await write(view, "\x1b[?1049l");
    expect(lines(view)).toEqual(lines(host));
  } finally {
    host.dispose();
    view.dispose();
  }
});

test("a changed pinned alternate-buffer separator refuses with a fixed compatibility error", async () => {
  const host = new Terminal({ allowProposedApi: true });
  const addon = new SerializeAddon();
  host.loadAddon(addon);
  try {
    await write(host, "\x1b[?1049h");
    vi.spyOn(addon, "serialize").mockReturnValue("changed serializer");
    expect(() => terminalSnapshot(host, addon)).toThrow(
      "Unsupported xterm alternate-buffer serialization",
    );
  } finally {
    host.dispose();
  }
});

test.each([false, true])(
  "opaque transport replay restores the live OSC pen (open=%s)",
  async (linked) => {
    const { linksOnRow } = await import("../../../src/renderer/terminal/link-lookup");
    const host = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const view = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const addon = new SerializeAddon();
    host.loadAddon(addon);
    try {
      await write(
        host,
        `\x1b]8;;https://budget.test/${"x".repeat(16000)}\x1b\\https://safe.example/\x1b]8;;\x1b\\\r\n`,
      );
      if (linked) await write(host, "\x1b]8;;https://live.test/\x1b\\");
      await write(
        view,
        terminalSnapshot(host, addon, (data) => data.length < 500),
      );
      await write(host, "https://after.test/");
      await write(view, "https://after.test/");
      expect(linksOnRow(view, 1)[0]?.url).toBe(
        linked ? "https://live.test/" : "https://after.test/",
      );
    } finally {
      host.dispose();
      view.dispose();
    }
  },
);

test.each(["wrapped", "gap"])(
  "budget drops every run of an over-budget OSC ID (%s)",
  async (kind) => {
    const { linksOnRow } = await import("../../../src/renderer/terminal/link-lookup");
    const { withSnapshotLinks } = await import("../../../src/terminal-host/snapshot-links");
    const { terminalOscId } = await import("../../../src/shared/terminal-link");
    const url = "https://evil.test/";
    const cols = kind === "wrapped" ? url.length : 80;
    const host = new Terminal({ cols, rows: 24, allowProposedApi: true });
    const view = new Terminal({ cols, rows: 24, allowProposedApi: true });
    const addon = new SerializeAddon();
    host.loadAddon(addon);
    const begin = `\x1b]8;id=same;${url}\x1b\\`;
    const end = "\x1b]8;;\x1b\\";
    try {
      await write(host, begin + url + (kind === "gap" ? end + " " + begin : "") + "tail" + end);
      expect(linksOnRow(host, 0)[0]?.url).toBe(url);
      const id = terminalOscId(host.buffer.active.getLine(0)?.getCell(0));
      const opening = `\x1b]8;id=foom-${String(id)};${url}\x1b\\`;
      const data = withSnapshotLinks(
        host,
        addon,
        (pen) => addon.serialize() + pen,
        opening.length + end.length - (kind === "wrapped" ? 1 : 0),
      );
      await write(view, data);
      expect(linksOnRow(view, 0)).toEqual([]);
    } finally {
      host.dispose();
      view.dispose();
    }
  },
);

test("one long OSC target over 300 wide glyphs retains every linked cell", async () => {
  const { terminalOscId, terminalOscTarget } = await import("../../../src/shared/terminal-link");
  const host = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const view = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const addon = new SerializeAddon();
  host.loadAddon(addon);
  const url = "https://wide.test/".padEnd(16000, "x");
  try {
    await write(host, `\x1b]8;;${url}\x1b\\${"中".repeat(300)}\x1b]8;;\x1b\\`);
    const data = terminalSnapshot(host, addon);
    await write(view, data);
    let retained = 0;
    for (let i = 0; i < 300; i++) {
      const id = terminalOscId(
        view.buffer.active.getLine(Math.floor(i / 40))?.getCell((i % 40) * 2),
      );
      if (id && terminalOscTarget(view, id) === url) retained++;
    }
    expect.soft(retained).toBe(300);
    expect(data.split(url)).toHaveLength(2);
  } finally {
    host.dispose();
    view.dispose();
  }
});

test("snapshot link adapter validates pinned row ranges and accepts marker coordinates", async () => {
  const { withSnapshotLinks } = await import("../../../src/terminal-host/snapshot-links");
  const host = new Terminal({ cols: 8, rows: 6, allowProposedApi: true });
  const addon = new SerializeAddon();
  host.loadAddon(addon);
  const run = (range: unknown) =>
    withSnapshotLinks(host, addon, (pen) => {
      const method: unknown = Reflect.get(addon, "_serializeBufferByRange");
      if (typeof method !== "function") throw new Error("Missing row serializer");
      const data: unknown = Reflect.apply(method, addon, [host, host.buffer.normal, range, true]);
      if (typeof data !== "string") throw new Error("Missing row string");
      return data + pen;
    });
  try {
    await write(host, "\x1b]8;;https://range.test/\x1b\\中A\x1b]8;;\x1b\\");
    for (const range of [
      undefined,
      {},
      { start: null, end: 1 },
      { start: -1, end: 1 },
      { start: 0.5, end: 1 },
      { start: { line: "bad" }, end: 1 },
      { start: 2, end: 1 },
    ])
      expect(() => run(range)).toThrow("Unsupported xterm row range");
    expect(run({ start: { line: 0 }, end: { line: 0 } })).toContain("https://range.test/");
  } finally {
    host.dispose();
  }
});

test.each([5, 8])(
  "wide OSC runs and pending-wrap row replay preserve both buffers at %s columns",
  async (cols) => {
    const { terminalOscId, terminalOscTarget } = await import("../../../src/shared/terminal-link");
    const host = new Terminal({ cols, rows: 8, allowProposedApi: true });
    const view = new Terminal({ cols, rows: 8, allowProposedApi: true });
    const addon = new SerializeAddon();
    host.loadAddon(addon);
    try {
      for (const alternate of [false, true]) {
        if (alternate) await write(host, "\x1b[?1049h");
        await write(
          host,
          "\x1b[2;7r\x1b[?6h\x1b]8;;https://wide.test/\x1b\\" + "ab中".repeat(4) + "\x1b]8;;\x1b\\",
        );
        view.reset();
        await write(view, terminalSnapshot(host, addon));
        expect(lines(view)).toEqual(lines(host));
        for (let row = 0; row < host.rows; row++)
          for (let col = 0; col < cols; col++) {
            const original = host.buffer.active.getLine(row)?.getCell(col);
            if (!original?.getChars()) continue;
            const id = terminalOscId(view.buffer.active.getLine(row)?.getCell(col));
            expect(id && terminalOscTarget(view, id)).toBe("https://wide.test/");
          }
      }
    } finally {
      host.dispose();
      view.dispose();
    }
  },
);

test("visible links in both buffers reserve budget before an expensive historical ID", async () => {
  const { terminalOscId, terminalOscTarget } = await import("../../../src/shared/terminal-link");
  const host = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const view = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const addon = new SerializeAddon();
  host.loadAddon(addon);
  const history = "https://history.test/".padEnd(16361, "x");
  const link = (url: string, label: string, id = "") =>
    `\x1b]8;${id};${url}\x1b\\${label}\x1b]8;;\x1b\\`;
  try {
    await write(host, (link(history, "x", "id=history") + " \r\n").repeat(256));
    await write(host, "\r\n".repeat(24) + link("https://normal.test/login", "login"));
    await write(host, "\x1b[?1049h\x1b[H" + link("https://alternate.test/login", "login"));
    await write(view, terminalSnapshot(host, addon));
    for (const buffer of [view.buffer.normal, view.buffer.alternate]) {
      const row = buffer.type === "normal" ? buffer.baseY + 23 : 0;
      const id = terminalOscId(buffer.getLine(row)?.getCell(0));
      expect(id && terminalOscTarget(view, id)).toBe(`https://${buffer.type}.test/login`);
    }
  } finally {
    host.dispose();
    view.dispose();
  }
});

test.each(["restore", "alternate"])(
  "documented dormant OSC pen limit after %s fails closed until explicit OSC open",
  async (kind) => {
    const { terminalOscId, terminalOscTarget } = await import("../../../src/shared/terminal-link");
    const host = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const view = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const addon = new SerializeAddon();
    host.loadAddon(addon);
    try {
      const begin = "\x1b]8;id=same;https://dormant.test/\x1b\\";
      if (kind === "alternate") await write(host, begin + "x\x1b]8;;\x1b\\");
      await write(
        host,
        (kind === "restore" ? "\x1b7" : "\x1b[?1049h") +
          begin +
          "x" +
          (kind === "restore" ? "\x1b8" : "\x1b[?1049l"),
      );
      await write(view, terminalSnapshot(host, addon));
      await write(host, "\x1b[4mW");
      await write(view, "\x1b[4mW");
      const target = (t: Terminal) => {
        const id = terminalOscId(t.buffer.active.getLine(0)?.getCell(t.buffer.active.cursorX - 1));
        return id ? terminalOscTarget(t, id) : undefined;
      };
      expect(target(host)).toBe("https://dormant.test/");
      // Restoring inactive extended metadata would also need saved-cursor state.
      // Do not turn a stale target into active link authority during replay.
      expect(target(view)).toBeUndefined();
      await write(view, "\x1b]8;;https://dormant.test/\x1b\\Z");
      expect(target(view)).toBe("https://dormant.test/");
    } finally {
      host.dispose();
      view.dispose();
    }
  },
);

test("after visible reservations history spends its budget newest first", async () => {
  const { withSnapshotLinks } = await import("../../../src/terminal-host/snapshot-links");
  const { terminalOscId, terminalOscTarget } = await import("../../../src/shared/terminal-link");
  const host = new Terminal({ cols: 80, rows: 3, allowProposedApi: true });
  const view = new Terminal({ cols: 80, rows: 3, allowProposedApi: true });
  const addon = new SerializeAddon();
  host.loadAddon(addon);
  const link = (url: string) => `\x1b]8;;${url}\x1b\\x\x1b]8;;\x1b\\`;
  try {
    await write(
      host,
      link("https://old.test/") +
        "\r\n" +
        link("https://new.test/") +
        "\r\n\r\n\r\n" +
        link("https://visible.test/"),
    );
    const cost = (row: number, url: string) =>
      `\x1b]8;id=foom-${String(terminalOscId(host.buffer.normal.getLine(row)?.getCell(0)))};${url}\x1b\\\x1b]8;;\x1b\\`
        .length;
    const data = withSnapshotLinks(
      host,
      addon,
      (pen) => addon.serialize() + pen,
      cost(1, "https://new.test/") + cost(4, "https://visible.test/"),
    );
    await write(view, data);
    const target = (row: number) => {
      const id = terminalOscId(view.buffer.normal.getLine(row)?.getCell(0));
      return id && terminalOscTarget(view, id);
    };
    expect(target(0)).toBe("foom-refused:");
    expect(target(1)).toBe("https://new.test/");
    expect(target(4)).toBe("https://visible.test/");
  } finally {
    host.dispose();
    view.dispose();
  }
});
