// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import { suppressTrackedMiddleClick } from "../../../../src/renderer/terminal/middle-click";

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
