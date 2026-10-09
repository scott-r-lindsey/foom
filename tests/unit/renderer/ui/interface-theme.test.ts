// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { attachInterfaceTheme } from "../../../../src/renderer/ui/interface-theme";
import { interfaceColorNames, interfaceThemes } from "../../../../src/shared/interface-themes";
import type { SetupState } from "../../../../src/shared/setup";
import { setupState } from "../../../fixtures/setup";
afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("style");
});
function media() {
  const state = {
    matches: false,
    addEventListener: vi.fn<(type: string, cb: () => void) => void>(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", () => state);
  return state;
}
test("applies complete token data, follows System, handles fixed/custom themes and removes listeners", async () => {
  const m = media();
  let changed: ((state: SetupState) => void) | undefined;
  const off = vi.fn();
  const dispose = attachInterfaceTheme({
    state: () => Promise.resolve(setupState()),
    subscribe: (cb) => {
      changed = cb;
      return off;
    },
  });
  await Promise.resolve();
  const root = document.documentElement;
  for (const key of interfaceColorNames)
    expect(root.style.getPropertyValue(`--${key}`)).toBe(
      interfaceThemes["eclipse-light"].colors[key],
    );
  m.matches = true;
  m.addEventListener.mock.calls[0]?.[1]();
  expect(root.style.colorScheme).toBe("dark");
  changed?.(setupState({ colorMode: "light" }));
  expect(root.style.colorScheme).toBe("light");
  changed?.(setupState({ colorMode: "dark" }));
  expect(root.style.colorScheme).toBe("dark");
  changed?.(setupState({ interfaceTheme: "moonlight" }));
  m.matches = false;
  m.addEventListener.mock.calls[0]?.[1]();
  expect(root.style.getPropertyValue("--bg")).toBe("#f5f7fc");
  changed?.(setupState({ interfaceTheme: interfaceThemes["deep-field"] }));
  expect(root.style.getPropertyValue("--bg")).toBe("#080f1e");
  for (const [id, theme] of Object.entries(interfaceThemes)) {
    changed?.(setupState({ interfaceTheme: theme }));
    expect(root.style.getPropertyValue("--highlight"), id).toBe(
      theme.colors.highlight ?? theme.colors.accent,
    );
    expect(root.style.getPropertyValue("--highlight-deep"), id).toBe(
      theme.colors["highlight-deep"] ?? theme.colors["accent-deep"],
    );
    expect(root.style.getPropertyValue("--accent"), id).toBe(theme.colors.accent);
  }
  dispose();
  expect(off).toHaveBeenCalledOnce();
  expect(m.removeEventListener).toHaveBeenCalledWith(
    "change",
    m.addEventListener.mock.calls[0]?.[1],
  );
  expect(root.getAttribute("style")).toBe("");
});
test("ignores stale initial reads and results after disposal; unreadable settings keep CSS fallback", async () => {
  media();
  let finish: ((state: SetupState) => void) | undefined;
  let changed: ((state: SetupState) => void) | undefined;
  const pending = new Promise<SetupState>((resolve) => {
    finish = resolve;
  });
  const dispose = attachInterfaceTheme({
    state: () => pending,
    subscribe: (cb) => {
      changed = cb;
      return () => {};
    },
  });
  changed?.(setupState({ interfaceTheme: "high-contrast" }));
  finish?.(setupState());
  await Promise.resolve();
  expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#000000");
  dispose();
  let late: ((state: SetupState) => void) | undefined;
  const off = attachInterfaceTheme({
    state: () =>
      new Promise((resolve) => {
        late = resolve;
      }),
    subscribe: () => () => {},
  });
  off();
  late?.(setupState());
  await Promise.resolve();
  expect(document.documentElement.style.length).toBe(0);
  const failed = attachInterfaceTheme({
    state: () => Promise.reject(Error("offline")),
    subscribe: () => () => {},
  });
  await Promise.resolve();
  expect(document.documentElement.style.length).toBe(0);
  failed();
});
