// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TerminalFontPicker } from "../../../../src/renderer/preflight/terminal-font-picker";
import type { SetupSource } from "../../../../src/renderer/preflight/setup-source.d";
import { DEFAULT_TERMINAL_FONT } from "../../../../src/shared/terminal-fonts";
afterEach(cleanup);
function source(
  listTerminalFonts?: (refresh?: boolean) => Promise<readonly string[]>,
): Pick<SetupSource, "listTerminalFonts"> {
  return listTerminalFonts ? { listTerminalFonts } : {};
}
test("bundled default comes first, families are validated and selection saves", async () => {
  const onChange = vi.fn();
  render(
    <TerminalFontPicker
      source={source(() => Promise.resolve(["Zed Mono", "Alpha Mono", 'bad"']))}
      value={DEFAULT_TERMINAL_FONT}
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Terminal font / }));
  await screen.findByRole("menuitemradio", { name: "Alpha Mono" });
  expect(
    screen.getAllByRole("menuitemradio").map((option) => option.textContent.replace(/^✓/, "")),
  ).toEqual(["Hack Nerd Font Mono (bundled)", "Alpha Mono", "Zed Mono"]);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Alpha Mono" }));
  expect(onChange).toHaveBeenCalledWith({ terminalFont: "Alpha Mono" });
  expect(onChange).toHaveBeenCalledOnce();
});
test("missing families stay selected and failures retain the default", async () => {
  const { rerender } = render(
    <TerminalFontPicker
      source={source(() => Promise.reject(new Error("unavailable")))}
      value="Missing Mono"
      onChange={vi.fn()}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(screen.getByRole("button", { name: "Terminal font Missing Mono" }));
  expect(
    screen.getByRole("menuitemradio", { name: "Missing Mono" }).getAttribute("aria-checked"),
  ).toBe("true");
  rerender(<TerminalFontPicker source={source()} value={'unsafe"'} onChange={vi.fn()} />);
  expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
});
test("late enumeration does not update an unmounted picker", async () => {
  let finish: (fonts: readonly string[]) => void = () => {};
  const { unmount } = render(
    <TerminalFontPicker
      source={source(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )}
      value={DEFAULT_TERMINAL_FONT}
      onChange={vi.fn()}
    />,
  );
  unmount();
  await act(async () => {
    finish(["Late Mono"]);
    await Promise.resolve();
  });
  expect(screen.queryByRole("menuitemradio")).toBeNull();
});

test("cached families show before the background refresh adds a new family", async () => {
  let finish: (fonts: readonly string[]) => void = () => {};
  const list = vi.fn((refresh?: boolean) =>
    refresh
      ? new Promise<readonly string[]>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(["Cached Mono"]),
  );
  const { unmount } = render(
    <TerminalFontPicker source={source(list)} value="Saved Mono" onChange={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Terminal font / }));
  await screen.findByRole("menuitemradio", { name: "Cached Mono" });
  expect(list.mock.calls).toEqual([[], [true]]);
  expect(screen.queryByRole("menuitemradio", { name: "New Mono" })).toBeNull();
  await act(async () => {
    finish(["Cached Mono", "New Mono", 'bad"']);
    await Promise.resolve();
  });
  expect(screen.getByRole("menuitemradio", { name: "New Mono" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Terminal font Saved Mono" })).toBeTruthy();
  expect(list).toHaveBeenCalledTimes(2);
  unmount();
});

test("a failed refresh keeps cached families", async () => {
  const list = vi.fn((refresh?: boolean) =>
    refresh ? Promise.reject(new Error("refresh failed")) : Promise.resolve(["Cached Mono"]),
  );
  render(
    <TerminalFontPicker source={source(list)} value={DEFAULT_TERMINAL_FONT} onChange={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Terminal font / }));
  await screen.findByRole("menuitemradio", { name: "Cached Mono" });
  expect(list).toHaveBeenCalledTimes(2);
});

test("a late refresh cannot update a replacement picker", async () => {
  let finish: (fonts: readonly string[]) => void = () => {};
  const list = vi.fn((refresh?: boolean) =>
    refresh
      ? new Promise<readonly string[]>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(["Cached Mono"]),
  );
  const { rerender } = render(
    <TerminalFontPicker source={source(list)} value={DEFAULT_TERMINAL_FONT} onChange={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Terminal font / }));
  await screen.findByRole("menuitemradio", { name: "Cached Mono" });
  rerender(
    <TerminalFontPicker
      source={source(() => Promise.resolve(["Replacement Mono"]))}
      value={DEFAULT_TERMINAL_FONT}
      onChange={vi.fn()}
    />,
  );
  await screen.findByRole("menuitemradio", { name: "Replacement Mono" });
  await act(async () => {
    finish(["Late Mono"]);
    await Promise.resolve();
  });
  expect(screen.queryByRole("menuitemradio", { name: "Late Mono" })).toBeNull();
});
