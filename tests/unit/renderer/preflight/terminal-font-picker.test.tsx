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
  await screen.findByRole("option", { name: "Alpha Mono" });
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "Hack Nerd Font Mono (bundled)",
    "Alpha Mono",
    "Zed Mono",
  ]);
  fireEvent.change(screen.getByLabelText("Terminal font"), { target: { value: "Alpha Mono" } });
  expect(onChange).toHaveBeenCalledWith({ terminalFont: "Alpha Mono" });
  fireEvent.change(screen.getByLabelText("Terminal font"), { target: { value: 'bad"' } });
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
  expect(screen.getByRole<HTMLOptionElement>("option", { name: "Missing Mono" }).selected).toBe(
    true,
  );
  rerender(<TerminalFontPicker source={source()} value={'unsafe"'} onChange={vi.fn()} />);
  expect(screen.getAllByRole("option")).toHaveLength(1);
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
  expect(screen.queryByRole("option")).toBeNull();
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
  await screen.findByRole("option", { name: "Cached Mono" });
  expect(list.mock.calls).toEqual([[], [true]]);
  expect(screen.queryByRole("option", { name: "New Mono" })).toBeNull();
  await act(async () => {
    finish(["Cached Mono", "New Mono", 'bad"']);
    await Promise.resolve();
  });
  expect(screen.getByRole("option", { name: "New Mono" })).toBeTruthy();
  expect(screen.getByRole<HTMLSelectElement>("combobox").value).toBe("Saved Mono");
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
  await screen.findByRole("option", { name: "Cached Mono" });
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
  await screen.findByRole("option", { name: "Cached Mono" });
  rerender(
    <TerminalFontPicker
      source={source(() => Promise.resolve(["Replacement Mono"]))}
      value={DEFAULT_TERMINAL_FONT}
      onChange={vi.fn()}
    />,
  );
  await screen.findByRole("option", { name: "Replacement Mono" });
  await act(async () => {
    finish(["Late Mono"]);
    await Promise.resolve();
  });
  expect(screen.queryByRole("option", { name: "Late Mono" })).toBeNull();
});
