// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BoardSource } from "../../../../src/renderer/board/board-source.d";
import { Board } from "../../../../src/renderer/board/board-view";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import type { ConfigStatus } from "../../../../src/shared/foom-config";
import { boardRows as sampleRows } from "../../../fixtures/board";
import { load } from "./sidebar-view-fixtures";
beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
});
afterEach(cleanup);

test("config panel orders Settings, launchers and folder commands; dock uses the gear anchor", async () => {
  const original = sampleRows(0)[0];
  if (!original) throw Error("fixture");
  const command = vi.fn(() => Promise.resolve());
  const settings = vi.fn();
  const openFolder = vi.fn(() => Promise.resolve());
  const base = createSampleSource([{ ...original, config: true, agent: "claude", exited: false }]);
  const view = render(
    <Board
      source={{
        ...base,
        sidebarCommand: command,
        worktrees: {
          load,
          branches: () =>
            Promise.resolve({ head: "main", local: [], remote: null, remoteBranches: [] }),
          addRepository: () => Promise.resolve(null),
          create: () => Promise.reject(Error("unused")),
          remove: () => Promise.resolve(false),
        },
        config: {
          status: () =>
            Promise.resolve({
              folder: "/config",
              available: true,
              pending: null,
              rejected: [],
            }),
          subscribe: () => () => {},
          openFolder,
        },
      }}
      onSettings={settings}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  const gear = view.container.querySelector<HTMLButtonElement>(".config-gear");
  const dock = view.container.querySelector<HTMLButtonElement>(".config-dock-head");
  if (!gear || !dock) throw Error("footer");
  fireEvent.click(dock);
  const panel = view.getByRole("dialog");
  const items = within(panel).getAllByRole("menuitem");
  expect(items.map((item) => item.textContent)).toEqual([
    "SettingsCtrl+,",
    "CCVia Claude Code",
    ">_Shell",
    "Open Foom config settings",
    "Open folder",
  ]);
  expect(items[0]).toBe(document.activeElement);
  fireEvent.click(items[0] ?? panel);
  expect(settings).toHaveBeenLastCalledWith();
  fireEvent.click(gear);
  fireEvent.click(view.getByRole("menuitem", { name: "Open Foom config settings" }));
  expect(settings).toHaveBeenLastCalledWith("config");
  fireEvent.click(gear);
  fireEvent.click(view.getByRole("menuitem", { name: /^Via Claude Code/ }));
  expect(command).toHaveBeenCalledWith({ kind: "config-launch", run: "claude" });
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(gear);
  fireEvent.click(view.getByRole("menuitem", { name: "Open folder" }));
  expect(openFolder).toHaveBeenCalledOnce();
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(gear);
  fireEvent.pointerDown(document.body);
  expect(view.queryByRole("dialog")).toBeNull();
});

test("config status changes remove an empty dock, retain an exited session and dispose the subscription", async () => {
  const original = sampleRows(0)[0];
  if (!original) throw Error("fixture");
  const base = createSampleSource([]);
  const off = vi.fn();
  let notify: ((status: ConfigStatus) => void) | undefined;
  const clean = {
    folder: "/config",
    available: true,
    pending: null,
    rejected: [],
  };
  const source: BoardSource = {
    ...base,
    config: {
      status: () => Promise.reject(Error("unavailable")),
      subscribe: (callback) => {
        notify = callback;
        return off;
      },
      openFolder: () => Promise.resolve(),
    },
  };
  const view = render(<Board source={source} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.container.querySelector(".config-dock")).toBeNull();
  act(() => {
    notify?.({ ...clean, rejected: [{ file: "settings.json", reason: "$: malformed-json" }] });
  });
  expect(view.container.querySelector(".config-dock")?.textContent).toContain("1 rejected");
  act(() => {
    notify?.(clean);
  });
  expect(view.container.querySelector(".config-dock")).toBeNull();
  const exited = createSampleSource([{ ...original, config: true, exited: true, state: "done" }]);
  view.rerender(<Board source={{ ...source, getSnapshot: exited.getSnapshot }} />);
  expect(view.container.querySelector(".config-dock .board-row")?.getAttribute("data-exited")).toBe(
    "true",
  );
  expect(view.container.querySelector(".config-dock")?.textContent).toContain("exited");
  view.unmount();
  expect(off).toHaveBeenCalled();
});
