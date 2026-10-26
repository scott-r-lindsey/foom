import { setupState } from "../../../fixtures/setup";
import type { SetupState } from "../../../../src/shared/setup";
// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import {
  suppressTrackedMiddleClick,
  TerminalSelectionBuffer,
  emulateMiddleClickPaste,
  attachTerminalSelectionBuffer,
} from "../../../../src/renderer/terminal/middle-click";

test("only tracked unmodified middle auxclick cancels paste and disposal restores it", async () => {
  const terminal = new Terminal();
  const container = document.createElement("div");
  const target = container.appendChild(document.createElement("textarea"));
  const bubbling = vi.fn();
  container.addEventListener("auxclick", bubbling);
  const dispose = suppressTrackedMiddleClick(
    container,
    {
      get modes() {
        return terminal.modes;
      },
    },
    "Linux x86_64",
  );
  const click = (button = 1, shiftKey = false, type = "auxclick") => {
    const event = new MouseEvent(type, { button, shiftKey, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(click()).toBe(false);
  for (const mode of [9, 1000, 1002, 1003]) {
    await new Promise<void>((resolve) => {
      terminal.write(`\x1b[?${String(mode)}h`, resolve);
    });
    expect(click()).toBe(true);
    expect(click(1, true)).toBe(false);
    expect(click(0)).toBe(false);
    expect(click(2)).toBe(false);
    expect(click(1, false, "mousedown")).toBe(false);
    await new Promise<void>((resolve) => {
      terminal.write(`\x1b[?${String(mode)}l`, resolve);
    });
    expect(click()).toBe(false);
  }
  expect(bubbling).toHaveBeenCalledTimes(21);
  const pasteTarget = vi.fn();
  target.addEventListener("paste", pasteTarget);
  const paste = () => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(paste()).toBe(false);
  await new Promise<void>((resolve) => {
    terminal.write("\x1b[?1000h", resolve);
  });
  click();
  expect(paste()).toBe(true);
  expect(paste()).toBe(false);
  expect(pasteTarget).toHaveBeenCalledTimes(2);
  click();
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
  expect(paste()).toBe(false);
  click();
  click(0, false, "mousedown");
  expect(paste()).toBe(false);
  click();
  click(1, true);
  expect(paste()).toBe(false);
  click();
  dispose();
  expect(paste()).toBe(false);
  expect(click()).toBe(false);
  terminal.dispose();
});

test("platforms without primary selection leave later clipboard paste untouched", async () => {
  const container = document.createElement("div");
  const terminal = new Terminal();
  await new Promise<void>((resolve) => {
    terminal.write("\x1b[?1000h", resolve);
  });
  for (const platform of ["MacIntel", "Win32"]) {
    const dispose = suppressTrackedMiddleClick(container, terminal, platform);
    const click = new MouseEvent("auxclick", { button: 1, cancelable: true });
    container.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    const paste = new Event("paste", { cancelable: true });
    container.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(false);
    dispose();
  }
  terminal.dispose();
});

test("private selection memory keeps the last nonempty bounded selection only while enabled", () => {
  const buffer = new TerminalSelectionBuffer();
  buffer.select("off");
  expect(buffer.read()).toBe("");
  buffer.setEnabled(true);
  buffer.select("first");
  buffer.select("");
  expect(buffer.read()).toBe("first");
  buffer.select("x".repeat(65_536));
  expect(buffer.read()).toHaveLength(65_536);
  buffer.select("y".repeat(65_537));
  expect(buffer.read()).toBe("x".repeat(65_536));
  buffer.select("last");
  expect(buffer.read()).toBe("last");
  buffer.setEnabled(false);
  buffer.setEnabled(true);
  expect(buffer.read()).toBe("");
});

test("macOS uses xterm paste across terminals, respects tracking and never uses clipboard", () => {
  const buffer = new TerminalSelectionBuffer();
  const clipboard = { readText: vi.fn(), writeText: vi.fn() };
  vi.stubGlobal("navigator", { platform: "MacIntel", clipboard });
  let selected = "";
  let changed = () => {};
  let accepts = true;
  const off = vi.fn();
  const terminal = {
    modes: { ...new Terminal().modes },
    getSelection: () => selected,
    onSelectionChange: (callback: () => void) => {
      changed = callback;
      return { dispose: off };
    },
    paste: vi.fn(),
    focus: vi.fn(),
  };
  const a = document.createElement("div");
  const b = document.createElement("div");
  const disposeA = emulateMiddleClickPaste(a, terminal, buffer);
  const other = { ...terminal, paste: vi.fn() };
  const disposeB = emulateMiddleClickPaste(b, other, buffer, "MacIntel", () => accepts);
  const click = (button = 1, shiftKey = false) => {
    const event = new MouseEvent("auxclick", { button, shiftKey, cancelable: true });
    b.dispatchEvent(event);
    return event.defaultPrevented;
  };
  selected = "PRIVATE";
  changed();
  expect(click()).toBe(false);
  buffer.setEnabled(true);
  changed();
  selected = "";
  changed();
  expect(click()).toBe(true);
  expect(other.paste).toHaveBeenLastCalledWith("PRIVATE");
  expect(click(0)).toBe(false);
  expect(click(2)).toBe(false);
  for (const mode of ["x10", "vt200", "drag", "any"] as const) {
    terminal.modes.mouseTrackingMode = mode;
    expect(click()).toBe(false);
    expect(click(1, true)).toBe(true);
  }
  accepts = false;
  expect(click(1, true)).toBe(false);
  accepts = true;
  buffer.setEnabled(false);
  expect(click(1, true)).toBe(false);
  expect(clipboard.readText).not.toHaveBeenCalled();
  expect(clipboard.writeText).not.toHaveBeenCalled();
  disposeA();
  disposeB();
  expect(off).toHaveBeenCalledTimes(2);
  buffer.setEnabled(true);
  buffer.select("later");
  expect(click(1, true)).toBe(false);
  for (const platform of ["Linux x86_64", "Win32"])
    emulateMiddleClickPaste(a, terminal, buffer, platform)();
  vi.unstubAllGlobals();
});

test("window setting subscription clears memory even without any terminal and ignores stale reads", async () => {
  const buffer = new TerminalSelectionBuffer();
  let receive = (_state: SetupState) => {};
  let finish = (_state: SetupState) => {};
  const off = vi.fn();
  const source = {
    state: () =>
      new Promise<SetupState>((resolve) => {
        finish = resolve;
      }),
    subscribe: (callback: (state: SetupState) => void) => {
      receive = callback;
      return off;
    },
  };
  const dispose = attachTerminalSelectionBuffer(source, buffer, "MacIntel");
  receive(setupState({ middleClickPaste: true }));
  buffer.select("PRIVATE");
  finish(setupState());
  await Promise.resolve();
  expect(buffer.read()).toBe("PRIVATE");
  receive(setupState());
  receive(setupState({ middleClickPaste: true }));
  expect(buffer.read()).toBe("");
  buffer.select("SECOND");
  dispose();
  expect(buffer.read()).toBe("");
  expect(off).toHaveBeenCalledOnce();
  receive(setupState({ middleClickPaste: true }));
  buffer.select("ignored");
  expect(buffer.read()).toBe("");
  for (const platform of ["MacIntel", "Linux x86_64", "Win32"]) {
    const stop = attachTerminalSelectionBuffer(source, buffer, platform);
    finish(setupState({ middleClickPaste: true }));
    await Promise.resolve();
    buffer.select("new");
    expect(buffer.read()).toBe(platform === "MacIntel" ? "new" : "");
    stop();
  }
  const stop = attachTerminalSelectionBuffer(source, buffer, "MacIntel");
  stop();
  finish(setupState({ middleClickPaste: true }));
  await Promise.resolve();
  buffer.select("disposed");
  expect(buffer.read()).toBe("");
  const failed = attachTerminalSelectionBuffer({
    ...source,
    state: () => Promise.reject(new Error("unavailable")),
  });
  await Promise.resolve();
  failed();
});
