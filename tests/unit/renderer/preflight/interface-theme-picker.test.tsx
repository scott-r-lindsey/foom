// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { InterfaceThemePicker } from "../../../../src/renderer/preflight/interface-theme-picker";
import { interfaceThemes } from "../../../../src/shared/interface-themes";
import { setupState } from "../../../fixtures/setup";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
test("selects System and each theme, previews every status, follows media and accepts portable palettes", () => {
  const media = {
    matches: false,
    addEventListener: vi.fn<(type: string, cb: () => void) => void>(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", () => media);
  const onChange = vi.fn();
  const view = render(
    <InterfaceThemePicker settings={setupState().settings} onChange={onChange} />,
  );
  const preview = screen.getByLabelText("Interface theme preview");
  expect(screen.getAllByRole("listitem")).toHaveLength(6);
  expect(screen.getByText("Needs you")).toBeTruthy();
  expect(screen.getByText("Failed")).toBeTruthy();
  expect(preview.style.getPropertyValue("--bg")).toBe("#f3f0fa");
  act(() => {
    media.matches = true;
    media.addEventListener.mock.calls[0]?.[1]();
  });
  expect(preview.style.getPropertyValue("--bg")).toBe("#05040a");
  for (const [id, theme] of Object.entries(interfaceThemes)) {
    fireEvent.click(screen.getByRole("button", { name: theme.name }));
    expect(onChange).toHaveBeenLastCalledWith({ interfaceTheme: id });
    view.rerender(
      <InterfaceThemePicker
        settings={setupState({ interfaceTheme: theme }).settings}
        onChange={onChange}
      />,
    );
    expect(preview.style.getPropertyValue("--highlight")).toBe(
      theme.colors.highlight ?? theme.colors.accent,
    );
    expect(preview.style.getPropertyValue("--highlight-deep")).toBe(
      theme.colors["highlight-deep"] ?? theme.colors["accent-deep"],
    );
    const swatches = screen.getByRole("button", { name: theme.name }).querySelectorAll("i");
    const expected = document.createElement("i");
    expected.style.backgroundColor = theme.colors.highlight ?? theme.colors.accent;
    expect(swatches[3]?.style.backgroundColor).toBe(expected.style.backgroundColor);
  }
  fireEvent.click(screen.getByRole("button", { name: /^System/ }));
  expect(onChange).toHaveBeenLastCalledWith({ interfaceTheme: "follow", colorMode: "system" });
  view.rerender(
    <InterfaceThemePicker
      settings={setupState({ colorMode: "dark" }).settings}
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("button", { name: "Eclipse Dark" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  view.rerender(
    <InterfaceThemePicker
      settings={setupState({ colorMode: "light" }).settings}
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("button", { name: "Eclipse Light" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  view.rerender(
    <InterfaceThemePicker
      settings={setupState({ interfaceTheme: "moonlight" }).settings}
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("button", { name: "Moonlight" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  view.rerender(
    <InterfaceThemePicker
      settings={setupState({ interfaceTheme: interfaceThemes["deep-field"] }).settings}
      onChange={onChange}
    />,
  );
  expect(screen.getByText("Deep Field · Custom theme")).toBeTruthy();
  expect(preview.style.getPropertyValue("--bg")).toBe("#080f1e");
  view.unmount();
  expect(media.removeEventListener).toHaveBeenCalledWith(
    "change",
    media.addEventListener.mock.calls[0]?.[1],
  );
});

test("custom themes follow built-ins and selection keeps their file identity", () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const onChange = vi.fn();
  const catalog = {
    interface: [
      {
        id: "user:custom.json" as const,
        theme: { ...interfaceThemes.graphite, name: "Graphite (custom)" },
      },
    ],
    terminal: [],
    errors: [],
  };
  render(
    <InterfaceThemePicker
      settings={setupState({ interfaceTheme: "user:custom.json" }).settings}
      catalog={catalog}
      onChange={onChange}
    />,
  );
  const custom = screen.getByRole("button", { name: "Graphite (custom)" });
  expect(custom.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(custom);
  expect(onChange).toHaveBeenCalledWith({ interfaceTheme: "user:custom.json" });
  expect(screen.getByLabelText("Interface theme preview").style.getPropertyValue("--bg")).toBe(
    interfaceThemes.graphite.colors.bg,
  );
});
