// @vitest-environment jsdom
import { Terminal } from "@xterm/headless";
import type { Terminal as BrowserTerminal } from "@xterm/xterm";
import { afterEach, expect, test, vi } from "vitest";
import { terminalLinks } from "../../../../src/renderer/terminal/link-interaction";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  document.body.replaceChildren();
});
async function fixture(cols = 40, rows = 5) {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  const url = "https://example.test/" + "a".repeat(90);
  await new Promise<void>((resolve) => {
    terminal.write(url, resolve);
  });
  const container = document.body.appendChild(document.createElement("div"));
  const screen = container.appendChild(document.createElement("div"));
  screen.className = "xterm-screen";
  vi.spyOn(screen, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 400, 100));
  const render: (() => void)[] = [];
  const dispose = vi.fn();
  const add = vi.spyOn(EventTarget.prototype, "addEventListener");
  const listeners = (type: string, target: EventTarget | undefined) =>
    add.mock.calls.flatMap(([name, callback], index) =>
      name === type &&
      (!target || add.mock.contexts[index] === target) &&
      typeof callback === "function"
        ? [callback]
        : [],
    );
  let selection = "";
  const view = {
    get options() {
      return terminal.options;
    },
    get buffer() {
      return terminal.buffer;
    },
    cols,
    rows,
    getSelection: () => selection,
    onWriteParsed: (callback: () => void) => {
      render.push(callback);
      return { dispose };
    },
    onRender: (callback: (event: { start: number; end: number }) => void) => {
      render.push(() => {
        callback({ start: 0, end: rows - 1 });
      });
      return { dispose };
    },
    onScroll: (callback: (event: number) => void) => {
      render.push(() => {
        callback(0);
      });
      return { dispose };
    },
    onResize: (callback: (event: { cols: number; rows: number }) => void) => {
      render.push(() => {
        callback({ cols, rows });
      });
      return { dispose };
    },
  } satisfies Pick<
    BrowserTerminal,
    | "options"
    | "buffer"
    | "cols"
    | "rows"
    | "getSelection"
    | "onRender"
    | "onScroll"
    | "onResize"
    | "onWriteParsed"
  >;
  Object.defineProperty(view, "_core", { get: (): unknown => Reflect.get(terminal, "_core") });
  let id: string | undefined = "one";
  const desktop = {
    openTerminalLink: vi.fn().mockResolvedValue(undefined),
    copyTerminalLink: vi.fn().mockResolvedValue(undefined),
  };
  const links = terminalLinks(container, view, () => id, desktop);
  cleanups.push(() => {
    links.dispose();
    terminal.dispose();
    vi.restoreAllMocks();
  });
  const mouse = (type: string, options: MouseEventInit = {}, trusted = true) => {
    const event = new MouseEvent(type, { clientX: 25, clientY: 30, button: 0, ...options });
    const proxy = new Proxy(event, {
      get: (value, key): unknown =>
        key === "isTrusted" ? trusted : Reflect.get(value, key, value),
    });
    listeners(type, container)[0]?.call(container, proxy);
    return event;
  };
  return {
    terminal,
    view,
    desktop,
    links,
    container,
    screen,
    mouse,
    render,
    get keyCallbacks() {
      return listeners("keydown", undefined);
    },
    dispose,
    url,
    select: (text: string) => {
      selection = text;
    },
    setId: (value?: string) => {
      id = value;
    },
  };
}

test("link overlays highlight all visible rows, retain focus on repaint and rebuild on scroll or resize", async () => {
  const f = await fixture();
  f.mouse("mousemove"); // No screen/overlay yet: lookup still works independently.
  f.render[0]?.();
  const link = f.container.querySelector<HTMLElement>(".terminal-link");
  expect(link?.children).toHaveLength(3);
  link?.focus();
  expect(f.screen.title).toBe(f.url);
  f.render[0]?.();
  expect(document.activeElement).toBe(link);
  f.mouse("mousemove", { clientY: 50 });
  expect(link?.classList.contains("hovered")).toBe(true);
  f.mouse("mouseleave");
  expect(f.screen.title).toBe("");
  link?.blur();
  f.view.cols = 50;
  f.render[3]?.();
  f.render[0]?.();
  expect(f.container.querySelector(".terminal-link")).not.toBe(link);
  f.screen.remove();
  f.render[2]?.();
  expect(f.links.at(new MouseEvent("mouseup"))).toBeUndefined();
});

test("only trusted primary clicks activate; stale right/middle releases, drags, selection and replacements refuse", async () => {
  const f = await fixture();
  f.render[0]?.();
  f.mouse("mousedown");
  f.mouse("mouseup");
  expect(f.desktop.openTerminalLink).toHaveBeenCalledExactlyOnceWith("one", f.url, f.url);
  for (const options of [
    { button: 1 },
    { button: 2 },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
  ]) {
    f.mouse("mousedown");
    f.mouse("mouseup", options);
    f.mouse("mousedown", options);
    f.mouse("mouseup");
  }
  f.mouse("mousedown", {}, false);
  f.mouse("mouseup");
  f.mouse("mousedown");
  f.mouse("mouseup", {}, false);
  f.mouse("mousedown");
  f.mouse("mouseup", { clientX: 50 });
  f.mouse("mousedown");
  f.mouse("mouseup", { clientY: 70 });
  f.mouse("mousedown");
  f.select("selection");
  f.mouse("mouseup");
  f.select("");
  f.mouse("mousedown");
  f.setId("two");
  f.mouse("mouseup");
  f.mouse("mousedown", { clientX: -1 });
  f.mouse("mouseup");
  f.setId();
  f.mouse("mousedown");
  f.mouse("mouseup");
  expect(f.desktop.openTerminalLink).toHaveBeenCalledTimes(1);
  expect(f.links.at(new MouseEvent("contextmenu", { clientX: 500, clientY: 30 }))).toBeUndefined();
  expect(f.links.at(new MouseEvent("contextmenu", { clientX: 30, clientY: 500 }))).toBeUndefined();
});

test("menu lookup needs no hover, copies exact targets and drops actions from a replaced attachment", async () => {
  const f = await fixture();
  f.render[0]?.();
  const event = new MouseEvent("contextmenu", { clientX: 25, clientY: 50, button: 2 });
  const menu = f.links.menu(event);
  expect(menu?.url).toBe(f.url);
  await menu?.copy();
  menu?.open();
  expect(f.desktop.copyTerminalLink).toHaveBeenCalledExactlyOnceWith("one", f.url);
  expect(f.desktop.openTerminalLink).toHaveBeenCalledExactlyOnceWith("one", f.url, f.url);
  f.desktop.openTerminalLink.mockRejectedValue(new Error("opener unavailable"));
  menu?.open();
  await Promise.resolve();
  f.setId("two");
  await menu?.copy();
  menu?.open();
  expect(f.desktop.copyTerminalLink).toHaveBeenCalledTimes(1);
  expect(f.desktop.openTerminalLink).toHaveBeenCalledTimes(2);
  f.setId();
  expect(f.links.menu(event)).toBeUndefined();
  expect(f.links.menu(new MouseEvent("contextmenu"))).toBeUndefined();
});

test("keyboard activation requires a trusted Enter and never opens output by itself", async () => {
  const f = await fixture();
  f.render[0]?.();
  const link = f.container.querySelector<HTMLElement>(".terminal-link");
  expect(f.desktop.openTerminalLink).not.toHaveBeenCalled();
  link?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(f.desktop.openTerminalLink).not.toHaveBeenCalled();
  const event = new KeyboardEvent("keydown", { key: "Enter" });
  const proxy = new Proxy(event, {
    get: (value, key): unknown =>
      key === "isTrusted"
        ? true
        : key === "preventDefault" || key === "stopPropagation"
          ? () => {}
          : Reflect.get(value, key, value),
  });
  f.keyCallbacks[0]?.call(link, proxy);
  expect(f.desktop.openTerminalLink).toHaveBeenCalledOnce();
  link?.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
  const context = vi.fn();
  f.container.addEventListener("contextmenu", context);
  for (const key of ["ContextMenu", "F10"]) {
    const menuEvent = new KeyboardEvent("keydown", { key, shiftKey: true });
    const trustedMenu = new Proxy(menuEvent, {
      get: (value, property): unknown =>
        property === "isTrusted"
          ? true
          : property === "preventDefault" || property === "stopPropagation"
            ? () => {}
            : Reflect.get(value, property, value),
    });
    f.keyCallbacks[0]?.call(link, trustedMenu);
  }
  expect(context).toHaveBeenCalledTimes(2);
  expect(f.desktop.openTerminalLink).toHaveBeenCalledOnce();
  f.setId();
  f.keyCallbacks[0]?.call(link, proxy);
  expect(f.desktop.openTerminalLink).toHaveBeenCalledOnce();
});

test("grid resize refreshes highlight geometry even when a short link's buffer range stays identical", async () => {
  const f = await fixture();
  f.terminal.reset();
  await new Promise<void>((resolve) => {
    f.terminal.write("https://x.test/", resolve);
  });
  f.render[0]?.();
  expect(f.container.querySelector<HTMLElement>(".terminal-link > span")?.style.width).toBe(
    "37.5%",
  );
  f.terminal.resize(80, 10);
  f.view.cols = 80;
  f.view.rows = 10;
  f.render[3]?.();
  f.render[0]?.();
  const segment = f.container.querySelector<HTMLElement>(".terminal-link > span");
  expect(segment?.style.width).toBe("18.75%");
  expect(segment?.style.height).toBe("10%");
});

test("activation rechecks visibility after a menu/keyboard overlay was cached", async () => {
  const f = await fixture();
  f.render[0]?.();
  const menu = f.links.menu(new MouseEvent("contextmenu", { clientX: 25, clientY: 30 }));
  f.terminal.options.theme = { foreground: "#000000", background: "#000000" };
  menu?.open();
  expect(f.desktop.openTerminalLink).toHaveBeenCalledExactlyOnceWith("one", f.url, undefined);
  f.terminal.reset();
  menu?.open();
  expect(f.desktop.openTerminalLink).toHaveBeenCalledTimes(1);
});

test("scroll events during a parse do no sweeps and coalesce into one rendered viewport", async () => {
  const lookup = await import("../../../../src/renderer/terminal/link-lookup");
  const f = await fixture();
  const sweep = vi.spyOn(lookup, "linksOnRow").mockReturnValue([]);
  let scrolls = 0;
  const off = f.terminal.onScroll(() => {
    scrolls++;
    f.render[2]?.();
  });
  cleanups.push(() => {
    off.dispose();
  });
  await new Promise<void>((resolve) => {
    f.terminal.write("Fixture output line\r\n".repeat(128), resolve);
  });
  expect(scrolls).toBeGreaterThan(100);
  expect(sweep.mock.calls.length).toBe(0);
  f.render[0]?.();
  expect(sweep).toHaveBeenCalledTimes(f.view.rows);
  f.render[0]?.();
  expect(sweep).toHaveBeenCalledTimes(f.view.rows);
});

test("activation confirms when scrolling clips any row of the complete label", async () => {
  const f = await fixture();
  const url = "https://good.example.evil.test/";
  f.terminal.reset();
  f.terminal.resize(25, 3);
  f.view.cols = 25;
  f.view.rows = 3;
  await new Promise<void>((resolve) => {
    f.terminal.write("one\r\ntwo\r\n" + url, resolve);
  });
  f.terminal.scrollToTop();
  const menu = f.links.menu(new MouseEvent("contextmenu", { clientX: 20, clientY: 105 }));
  expect(menu?.url).toBe(url);
  menu?.open();
  expect(f.desktop.openTerminalLink).toHaveBeenCalledExactlyOnceWith("one", url, undefined);
  f.terminal.scrollToBottom();
  f.render[0]?.();
  f.links.menu(new MouseEvent("contextmenu", { clientX: 20, clientY: 105 }))?.open();
  expect(f.desktop.openTerminalLink).toHaveBeenLastCalledWith("one", url, url);
});

test.each([
  [80, 24],
  [120, 40],
])(
  "one MiB parser fixture has zero viewport sweeps before its frame (%s x %s)",
  async (cols, rows) => {
    const lookup = await import("../../../../src/renderer/terminal/link-lookup");
    const f = await fixture(cols, rows);
    const base = new Terminal({ cols, rows, allowProposedApi: true });
    cleanups.push(() => {
      base.dispose();
    });
    const write = (terminal: Terminal, data: string) =>
      new Promise<void>((resolve) => {
        terminal.write(data, resolve);
      });
    await write(base, f.url);
    const line = "Fixture output line\r\n";
    const data = line.repeat(Math.ceil((1024 * 1024) / line.length));
    const baselineStart = performance.now();
    await write(base, data);
    const baselineMs = performance.now() - baselineStart;
    const sweeps = vi.spyOn(lookup, "linksOnRow");
    const off = f.terminal.onScroll(() => f.render[2]?.());
    cleanups.push(() => {
      off.dispose();
    });
    const linkedStart = performance.now();
    await write(f.terminal, data);
    const linkedMs = performance.now() - linkedStart;
    expect(sweeps.mock.calls.length).toBe(0);
    f.render[0]?.();
    expect(sweeps.mock.calls.length).toBe(rows);
    // Diagnostic only: regression correctness is the operation count, not timing.
    console.info(JSON.stringify({ cols, rows, bytes: data.length, baselineMs, linkedMs }));
  },
);

test("press-time label cannot be replaced by a matching label before release", async () => {
  const f = await fixture();
  const url = "https://evil.test/path";
  const show = (label: string) =>
    new Promise<void>((resolve) => {
      f.terminal.write(`\x1bc\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`, resolve);
    });
  await show("https://good.example/path");
  f.render[0]?.();
  f.mouse("mousedown");
  await show(url);
  f.render[0]?.();
  f.mouse("mouseup");
  expect(f.desktop.openTerminalLink).toHaveBeenCalledExactlyOnceWith("one", url, undefined);
});

test.each(["unrendered", "parsed", "scrolled"])(
  "unpainted %s link confirms until the next frame",
  async (kind) => {
    const f = await fixture();
    if (kind !== "unrendered") f.render[0]?.();
    if (kind === "parsed") f.render[1]?.();
    if (kind === "scrolled") f.render[2]?.();
    f.mouse("mousedown");
    f.mouse("mouseup");
    expect(f.desktop.openTerminalLink).toHaveBeenLastCalledWith("one", f.url, undefined);
    f.render[0]?.();
    f.mouse("mousedown");
    f.mouse("mouseup");
    expect(f.desktop.openTerminalLink).toHaveBeenLastCalledWith("one", f.url, f.url);
  },
);
