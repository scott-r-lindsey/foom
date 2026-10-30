// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { terminalContextMenu } from "../../../../src/renderer/terminal/context-menu";
import type { TerminalContextMenu } from "../../../../src/renderer/terminal/terminal-view-source.d";

test.each(["Linux x86_64", "Win32", "MacIntel"])(
  "context dispatch preserves tracked input on %s",
  (platform) => {
    const container = document.createElement("div");
    const textarea = container.appendChild(document.createElement("textarea"));
    let tracking: "none" | "vt200" = "none";
    let id: string | undefined = "a";
    let text = "";
    const terminal = {
      get modes() {
        return { mouseTrackingMode: tracking };
      },
      textarea,
      getSelection: () => text,
      selectAll: vi.fn(),
      clear: vi.fn(),
      focus: vi.fn(),
    };
    const desktop = {
      appMenu: { execute: vi.fn().mockResolvedValue(undefined) },
    };
    const opened: TerminalContextMenu[] = [];
    const off = terminalContextMenu(
      container,
      terminal,
      () => id,
      (menu) => opened.push(menu),
      desktop,
      platform,
    );
    const received = vi.fn();
    textarea.addEventListener("mousedown", received);
    const gesture = (button: number, shiftKey = false, ctrlKey = false) => {
      textarea.dispatchEvent(
        new MouseEvent("mousedown", { button, shiftKey, ctrlKey, bubbles: true, cancelable: true }),
      );
      const event = new MouseEvent("contextmenu", {
        button,
        shiftKey,
        ctrlKey,
        bubbles: true,
        cancelable: true,
        clientX: 45,
        clientY: 60,
      });
      textarea.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    };
    gesture(2);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.copy).toBeUndefined();
    expect(opened[0]?.point).toEqual({ x: 45, y: 60 });
    expect(opened[0]?.anchor).toBe(textarea);
    expect(received).not.toHaveBeenCalled();
    tracking = "vt200";
    gesture(2);
    expect(opened).toHaveLength(1);
    expect(received).toHaveBeenCalledOnce();
    text = "selection";
    gesture(2, true);
    expect(opened).toHaveLength(2);
    const menu = opened[1];
    void menu?.copy?.();
    void menu?.paste();
    menu?.selectAll();
    menu?.clear();
    expect(desktop.appMenu.execute).toHaveBeenCalledWith("copy");
    expect(desktop.appMenu.execute).toHaveBeenCalledWith("paste");
    expect(terminal.focus).toHaveBeenCalledTimes(2);
    expect(terminal.selectAll).toHaveBeenCalledOnce();
    expect(terminal.clear).toHaveBeenCalledOnce();
    id = "b";
    void menu?.copy?.();
    void menu?.paste();
    menu?.selectAll();
    menu?.clear();
    expect(terminal.clear).toHaveBeenCalledOnce();
    gesture(0, false, true);
    expect(opened).toHaveLength(2);
    gesture(0, true, true);
    expect(opened).toHaveLength(platform === "MacIntel" ? 3 : 2);
    tracking = "none";
    gesture(0, false, true);
    expect(opened).toHaveLength(platform === "MacIntel" ? 4 : 2);
    id = undefined;
    gesture(2);
    expect(opened).toHaveLength(platform === "MacIntel" ? 4 : 2);
    off();
    textarea.dispatchEvent(new MouseEvent("contextmenu", { button: 2 }));
    expect(opened).toHaveLength(platform === "MacIntel" ? 4 : 2);
  },
);

test("container is the fallback anchor", () => {
  const container = document.createElement("div");
  const open = vi.fn<(menu: TerminalContextMenu) => void>();
  const terminal = {
    modes: { mouseTrackingMode: "none" as const },
    textarea: undefined,
    getSelection: () => "",
    selectAll: vi.fn(),
    clear: vi.fn(),
    focus: vi.fn(),
  };
  const off = terminalContextMenu(container, terminal, () => "a", open, {
    appMenu: { execute: vi.fn() },
  });
  container.dispatchEvent(new MouseEvent("contextmenu", { button: 2 }));
  expect(open.mock.calls[0]?.[0].anchor).toBe(container);
  off();
});
