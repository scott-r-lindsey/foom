// @vitest-environment jsdom
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BoardSource } from "../../../../src/renderer/board/board-source.d";
import type { SidebarCommandResult } from "../../../../src/shared/workspace";
import { Board } from "../../../../src/renderer/board/board-view";
import { setup } from "./sidebar-view-fixtures";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

async function slowLaunch(machine = false, agent = false, remoteCheckout = false) {
  const view = setup();
  if (remoteCheckout)
    act(() => {
      view.base.update("a", { placement: { kind: "remote", host: "dozer" } });
    });
  let finish: (value: SidebarCommandResult) => void = () => {};
  let fail: (error: Error) => void = () => {};
  let started = () => {};
  let id = "";
  const command = vi.fn<NonNullable<BoardSource["sidebarCommand"]>>((_value, startup) => {
    if (!startup) throw new Error("Missing startup presentation");
    id = startup.id;
    started = startup.started;
    return new Promise<SidebarCommandResult>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  });
  const cancel = vi.fn(() => Promise.resolve());
  view.source.sidebarCommand = command;
  view.source.cancelSidebarLaunch = cancel;
  view.source.getMachines = () => [
    {
      host: "dozer",
      name: "Build box",
      available: true,
      agents: [{ id: "claude", name: "Claude Code" }],
    },
  ];
  view.rerender(<Board source={view.source} />);
  await act(async () => {
    await Promise.resolve();
  });
  const launch = () => {
    fireEvent.click(
      view.getByRole("button", { name: machine ? "Actions for Build box" : "Actions for feature" }),
    );
    fireEvent.click(
      view.getByRole("menuitem", {
        name: machine
          ? agent
            ? "New Claude Code"
            : "New shell"
          : agent
            ? "Claude Code"
            : "Shell (zsh)",
      }),
    );
  };
  launch();
  return {
    ...view,
    command,
    cancel,
    launch,
    finish: (value: SidebarCommandResult) => {
      finish(value);
    },
    fail: (error: Error) => {
      fail(error);
    },
    started: () => {
      started();
    },
    id: () => id,
  };
}

test.each([false, true])(
  "a blocked machine launch has its final tile immediately, uses the display name and prevents duplicates (agent=%s)",
  async (agent) => {
    const view = await slowLaunch(true, agent);
    const startup = view.getByText("Starting on Build box…");
    const tile = startup.closest("[data-tile]");
    expect(tile).toBeTruthy();
    expect(view.queryByRole("menu")).toBeNull();
    view.launch();
    expect(view.command).toHaveBeenCalledOnce();
    const original = view.source.getSnapshot()[0];
    if (!original) throw new Error("Missing fixture row");
    const liveRows = [
      ...view.source.getSnapshot(),
      { ...original, id: "created", placement: { kind: "remote" as const, host: "dozer" } },
    ];
    view.source.getSnapshot = () => liveRows;
    await act(async () => {
      view.started();
      view.finish({ terminalId: "created" });
      await Promise.resolve();
    });
    expect(view.queryByText("Starting on Build box…")).toBeNull();
    expect(tile?.getAttribute("data-empty")).toBe("false");
    expect(tile?.querySelector(".tile-name")).toBeTruthy();
  },
);

test("local startup reserves a tile before discovery completes and a failure stays in that tile", async () => {
  const view = await slowLaunch(false, true);
  const startup = view.getByText("Starting on Local…");
  const tile = startup.closest("[data-tile]");
  expect(startup.parentElement?.getAttribute("data-remote")).toBe("false");
  await act(async () => {
    view.started();
    await Promise.resolve();
  });
  expect(view.queryByRole("menu")).toBeNull();
  await act(async () => {
    view.fail(new Error("Launch failed"));
    await Promise.resolve();
  });
  expect(tile?.querySelector('[data-failed="true"]')?.textContent).toContain(
    "Unable to launch session.",
  );
});

test("closing during startup cancels its operation and completion cannot reopen the tile", async () => {
  const view = await slowLaunch(true);
  const tile = view.getByText("Starting on Build box…").closest("[data-tile]");
  const close = tile?.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
  if (!close) throw new Error("Missing close control");
  fireEvent.click(close);
  expect(view.cancel).toHaveBeenCalledWith(view.id());
  expect(view.queryByText("Starting on Build box…")).toBeNull();
  await act(async () => {
    view.finish(undefined);
    await Promise.resolve();
  });
  expect(tile?.getAttribute("data-empty")).toBe("true");
});

test("a refused launch retains an explanatory failure in its reserved tile", async () => {
  const view = await slowLaunch(true);
  await act(async () => {
    view.finish(undefined);
    await Promise.resolve();
  });
  expect(view.getByText("Launch was cancelled or refused.")).toBeTruthy();
});

test("a remote session's host still names startup when checkout inventory has no host field", async () => {
  const view = await slowLaunch(false, true, true);
  expect(view.getByText("Starting on Build box…")).toBeTruthy();
  await act(async () => {
    view.finish(undefined);
    await Promise.resolve();
  });
});
