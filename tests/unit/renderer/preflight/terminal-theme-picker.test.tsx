// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TerminalThemePicker } from "../../../../src/renderer/preflight/terminal-theme-picker";
import { terminalThemes } from "../../../../src/shared/terminal-themes";
import { setupState } from "../../../fixtures/setup";
afterEach(cleanup);
test("previews all ANSI colors and text styles, saves a scheme, follows media and disposes", () => {
  const media = {
    matches: false,
    addEventListener: vi.fn<(name: string, callback: () => void) => void>(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", () => media);
  const onChange = vi.fn();
  const { rerender, unmount } = render(
    <TerminalThemePicker settings={setupState().settings} onChange={onChange} />,
  );
  const preview = screen.getByLabelText("Terminal theme preview");
  expect(preview.style.backgroundColor).toBe("rgb(243, 240, 250)");
  expect(preview.querySelectorAll("[title]")).toHaveLength(16);
  expect(preview.textContent).toContain("Bold text · Dim text");
  fireEvent.click(screen.getByRole("button", { name: "Dracula" }));
  expect(onChange).toHaveBeenCalledWith({ terminalTheme: "dracula" });
  act(() => {
    media.matches = true;
    media.addEventListener.mock.calls[0]?.[1]();
  });
  expect(preview.style.backgroundColor).toBe("rgb(5, 4, 10)");
  rerender(
    <TerminalThemePicker
      settings={setupState({ terminalTheme: "dracula" }).settings}
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("button", { name: "Dracula" }).getAttribute("aria-pressed")).toBe("true");
  expect(preview.style.backgroundColor).toBe("rgb(40, 42, 54)");
  rerender(
    <TerminalThemePicker
      settings={setupState({ terminalTheme: terminalThemes.dracula }).settings}
      onChange={onChange}
    />,
  );
  expect(screen.getByText("Custom theme")).toBeTruthy();
  unmount();
  expect(media.removeEventListener).toHaveBeenCalledWith(
    "change",
    media.addEventListener.mock.calls[0]?.[1],
  );
  vi.unstubAllGlobals();
});

test("custom terminal palettes select by file ID and preview parsed colors", () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const onChange = vi.fn();
  const catalog = {
    interface: [],
    terminal: [
      { id: "user:term.json" as const, name: "Terminal custom", theme: terminalThemes.dracula },
    ],
    errors: [],
  };
  render(
    <TerminalThemePicker
      settings={setupState({ terminalTheme: "user:term.json" }).settings}
      catalog={catalog}
      onChange={onChange}
    />,
  );
  const custom = screen.getByRole("button", { name: "Terminal custom" });
  expect(custom.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(custom);
  expect(onChange).toHaveBeenCalledWith({ terminalTheme: "user:term.json" });
  expect(screen.getByLabelText("Terminal theme preview").style.backgroundColor).toBe(
    "rgb(40, 42, 54)",
  );
});
