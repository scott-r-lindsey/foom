import { useBoardTiles } from "../../../../src/renderer/board/use-board-tiles";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import {
  initialLayout,
  placeContent,
  saveLayout,
  TILE_STORAGE,
} from "../../../../src/renderer/board/tiles";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  ActionError,
  registerErrorFocus,
  captureErrorFocus,
  BackgroundErrorMark,
  ErrorPresentation,
  useBackgroundErrors,
} from "../../../../src/renderer/board/error-presentation";

afterEach(cleanup);

test("action dialogs select no button, dismiss on cancel and restore focus; fixes require a click", () => {
  const fix = vi.fn();
  function Fixture() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <input aria-label="Terminal" />
        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
        >
          Fail
        </button>
        {open && (
          <ActionError
            message="This worktree needs pruning."
            close={() => {
              setOpen(false);
            }}
            fix={{ label: "Prune", run: fix }}
          />
        )}
      </>
    );
  }
  render(<Fixture />);
  const terminal = screen.getByRole("textbox");
  terminal.focus();
  fireEvent.click(screen.getByRole("button", { name: "Fail" }));
  const dialog = screen.getByRole("dialog", { name: "Action failed" });
  expect(document.activeElement).toBe(dialog);
  fireEvent.keyDown(dialog, { key: "Enter" });
  expect(fix).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Prune" }));
  expect(fix).toHaveBeenCalledOnce();
  fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(terminal);
  fireEvent.click(screen.getByRole("button", { name: "Fail" }));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(terminal);
});

test("background failures stay scoped, never focus, and clear independently on dismissal or success", () => {
  let errors: ReturnType<typeof useBackgroundErrors> | undefined;
  function Fixture() {
    errors = useBackgroundErrors();
    return (
      <>
        <input aria-label="Terminal" />
        <BackgroundErrorMark />
        <BackgroundErrorMark row="row" />
      </>
    );
  }
  render(
    <ErrorPresentation>
      <Fixture />
    </ErrorPresentation>,
  );
  const terminal = screen.getByRole("textbox");
  terminal.focus();
  act(() => {
    errors?.report("layout", "Unable to save tile layout.");
    errors?.report("watch", "Unable to watch checkout.", "row");
    errors?.report("layout", "Unable to save tile layout.");
    errors?.clear("absent");
  });
  expect(document.activeElement).toBe(terminal);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getAllByRole("button", { name: "Show failure" })).toHaveLength(2);
  const mark = screen.getAllByRole("button", { name: "Show failure" })[0];
  if (!mark) throw new Error("Missing mark");
  fireEvent.click(mark);
  expect(mark.parentElement?.dataset["expanded"]).toBe("true");
  fireEvent.click(mark);
  expect(mark.parentElement?.dataset["expanded"]).toBe("false");
  act(() => {
    errors?.clear("watch");
  });
  expect(screen.getAllByRole("button", { name: "Show failure" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("button", { name: "Show failure" })).toBeNull();
});

test("a failed action retains its menu anchor even after that menu disappears", () => {
  const origin = document.createElement("button");
  const menu = document.createElement("div");
  const item = document.createElement("button");
  menu.append(item);
  document.body.append(origin, menu);
  const dismiss = vi.fn();
  const unregister = registerErrorFocus(menu, origin, dismiss);
  item.focus();
  const returnFocus = captureErrorFocus();
  expect(returnFocus).toBe(origin);
  menu.remove();
  const view = render(
    <ActionError
      message="Unable to complete this action."
      returnFocus={() => returnFocus}
      close={() => {
        view.unmount();
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(document.activeElement).toBe(origin);
  expect(dismiss).toHaveBeenCalledOnce();
  unregister();
});

test("nested menus retain the outer row as their error focus origin", () => {
  const row = document.createElement("button");
  const parent = document.createElement("div");
  const trigger = document.createElement("button");
  parent.append(trigger);
  const nested = document.createElement("div");
  const item = document.createElement("button");
  nested.append(item);
  document.body.append(row, parent, nested);
  const removeParent = registerErrorFocus(parent, row, () => {});
  const removeNested = registerErrorFocus(nested, trigger, () => {});
  item.focus();
  expect(captureErrorFocus()).toBe(row);
  removeNested();
  removeParent();
});

test("implicit preview cleanup during a background placement marks its row and clears on success", async () => {
  localStorage.clear();
  const preview = {
    id: "preview",
    repository: "/repo",
    worktree: "/repo",
    relativePath: "plan.md",
    kind: "markdown" as const,
    network: false,
  };
  const layout = placeContent(initialLayout(), { kind: "preview", preview: preview.id });
  if (!layout) throw new Error("Missing fixture layout");
  saveLayout(localStorage, layout);
  const actionError = vi.fn();
  const close = vi.fn(() => Promise.resolve()).mockRejectedValueOnce(new Error("raw details"));
  let tiles: ReturnType<typeof useBoardTiles> | undefined;
  const source = {
    ...createSampleSource([]),
    isReady: () => false,
    previews: {
      getSnapshot: () => [preview],
      pick: () => Promise.resolve(null),
      bounds: () => Promise.resolve(),
      close,
    },
  };
  function Fixture() {
    tiles = useBoardTiles({
      source,
      soundSetup: undefined,
      rows: [],
      previews: [preview],
      storageKey: TILE_STORAGE,
      setArrivals: () => {},
      setRemoveError: actionError,
    });
    return <input aria-label="Terminal" />;
  }
  render(
    <ErrorPresentation>
      <Fixture />
      <BackgroundErrorMark row={preview.id} />
    </ErrorPresentation>,
  );
  const terminal = screen.getByRole("textbox");
  terminal.focus();
  await act(async () => {
    tiles?.changeLayout(initialLayout(), true);
    await Promise.resolve();
  });
  expect(actionError).not.toHaveBeenCalled();
  expect(screen.getByText("Unable to close preview.")).toBeTruthy();
  expect(document.activeElement).toBe(terminal);
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => {
    tiles?.changeLayout(layout);
    tiles?.changeLayout(initialLayout(), true);
    await Promise.resolve();
  });
  expect(screen.queryByRole("button", { name: "Show failure" })).toBeNull();
  localStorage.clear();
});
