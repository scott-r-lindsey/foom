// @vitest-environment jsdom
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BoardSource } from "../../../../src/renderer/board/board-source.d";
import type { SidebarCommandResult } from "../../../../src/shared/workspace";
import { Board } from "../../../../src/renderer/board/board-view";
import { setup, load, repository } from "./sidebar-view-fixtures";
import type { ArmedConfirmation } from "../../../../src/shared/confirmation";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

async function slowLaunch(machine = false, agent = false, remoteCheckout = false, sharing = true) {
  const view = setup();
  if (!sharing)
    act(() => {
      view.base.update("a", { exited: true });
    });
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
  expect(view.queryByText("Starting on Local…")).toBeNull();
  act(() => {
    view.started();
  });
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
    view.started();
    view.finish(undefined);
    await Promise.resolve();
  });
  expect(view.getByText("Launch was cancelled or refused.")).toBeTruthy();
});

test("a remote session's host still names startup when checkout inventory has no host field", async () => {
  const view = await slowLaunch(false, true, true);
  act(() => {
    view.started();
  });
  expect(view.getByText("Starting on Build box…")).toBeTruthy();
  await act(async () => {
    view.finish(undefined);
    await Promise.resolve();
  });
});

test("abandoning a sharing warning never reserves a tile or leaves a failure across retries", async () => {
  const view = await slowLaunch(false, true);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) view.launch();
    expect(view.queryByText("Starting on Local…")).toBeNull();
    await act(async () => {
      view.finish(undefined);
      await Promise.resolve();
    });
    expect(view.queryByText("Launch was cancelled or refused.")).toBeNull();
    expect(view.container.querySelectorAll('.terminal-tile[data-empty="false"]')).toHaveLength(0);
    expect(view.queryByRole("alertdialog")).toBeNull();
  }
  expect(view.command).toHaveBeenCalledTimes(3);
});

test("a main-process late cleanup failure after Close remains visible", async () => {
  const view = await slowLaunch(true);
  const tile = view.getByText("Starting on Build box…").closest("[data-tile]");
  const close = tile?.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
  if (!close) throw new Error("Missing close control");
  await act(async () => {
    fireEvent.click(close);
    await Promise.resolve();
  });
  expect(view.cancel).toHaveBeenCalledOnce();
  await act(async () => {
    view.fail(
      new Error(
        "Error invoking remote method 'workspace:sidebar-command': Error: foom-error:launch-cancel-incomplete",
      ),
    );
    await Promise.resolve();
  });
  expect(view.getByRole("dialog")).toBeTruthy();
  expect(view.getByRole("alert").textContent).toContain("Terminal may still be running.");
  expect(view.queryByText("Starting on Build box…")).toBeNull();
});

test("an accepted sharing warning reserves its tile only when main starts the launch", async () => {
  const view = await slowLaunch(false, true);
  expect(view.queryByText("Starting on Local…")).toBeNull();
  act(() => {
    view.started();
    view.started();
  });
  expect(view.getAllByText("Starting on Local…")).toHaveLength(1);
  await act(async () => {
    view.finish(undefined);
    await Promise.resolve();
  });
  expect(view.getByText("Launch was cancelled or refused.")).toBeTruthy();
});

test("a normal pre-spawn cancellation rejection does not report a surviving terminal", async () => {
  const view = await slowLaunch(true);
  const tile = view.getByText("Starting on Build box…").closest("[data-tile]");
  const close = tile?.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
  if (!close) throw new Error("Missing close control");
  await act(async () => {
    fireEvent.click(close);
    view.fail(new Error("foom-error:operation-failed"));
    await Promise.resolve();
  });
  expect(view.queryByText("Terminal may still be running.")).toBeNull();
  expect(view.queryByText("Unable to cancel launch.")).toBeNull();
});

test("a declined sharing warning discovered after the UI snapshot creates no temporary tile", async () => {
  const view = await slowLaunch(false, true, false, false);
  expect(view.queryByText("Starting on Local…")).toBeNull();
  await act(async () => {
    view.finish(undefined);
    await Promise.resolve();
  });
  expect(view.queryByText("Starting on Local…")).toBeNull();
  expect(view.queryByText("Launch was cancelled or refused.")).toBeNull();
  expect(view.container.querySelectorAll('.terminal-tile[data-empty="false"]')).toHaveLength(0);
});

test.each([false, true])(
  "main's sharing warning stays answerable despite a stale renderer inventory (other clone=%s)",
  async (otherClone) => {
    const view = setup();
    const second = { ...repository, path: "/clone-b", name: "Clone B", worktrees: [] };
    const repositories = [repository, second];
    view.source.getSidebar = () => repositories;
    if (!view.source.worktrees) throw new Error("Missing worktrees");
    view.source.worktrees.load = async () => ({ ...(await load()), repositories });
    act(() => {
      view.base.update(
        "a",
        otherClone
          ? {
              worktree: "/foom-remote/shared-origin",
              branch: "Main checkout",
              placement: { kind: "remote", host: "dozer" },
            }
          : { exited: true },
      );
    });
    view.source.getMachines = () => [
      {
        host: "dozer",
        name: "Build box",
        available: true,
        agents: [{ id: "claude", name: "Claude Code" }],
        repositories: ["/foom", "/clone-b"],
      },
    ];
    const listeners = new Set<(arm: ArmedConfirmation | null, accepted?: boolean) => void>();
    const operation = Promise.withResolvers<SidebarCommandResult>();
    let started = () => {};
    const arm = {
      nonce: "main-nonce",
      target: "resolved-checkout",
      label: "Click again for multiple agents here",
    };
    const confirm = vi.fn(() => {
      for (const receive of listeners) receive(null, true);
      started();
      return Promise.resolve();
    });
    view.source.confirmations = {
      subscribe: (receive) => {
        listeners.add(receive);
        return () => {
          listeners.delete(receive);
        };
      },
      confirm,
      cancel: () => Promise.resolve(),
    };
    view.source.cancelSidebarLaunch = () => Promise.resolve();
    view.source.sidebarCommand = vi.fn<NonNullable<BoardSource["sidebarCommand"]>>(
      (_command, startup) => {
        if (!startup) throw new Error("Missing startup");
        started = startup.started;
        return operation.promise;
      },
    );
    view.rerender(<Board source={view.source} />);
    await act(async () => {
      await Promise.resolve();
    });
    if (otherClone) {
      fireEvent.click(view.getByRole("button", { name: "Actions for Clone B" }));
      fireEvent.click(view.getByRole("menuitem", { name: "New agent" }));
      fireEvent.click(view.getByRole("menuitem", { name: "Build box" }));
    } else {
      fireEvent.click(view.getByRole("button", { name: "Expand Foom" }));
      fireEvent.click(view.getByRole("button", { name: "Actions for feature" }));
    }
    fireEvent.click(view.getByRole("menuitem", { name: "Claude Code" }));
    act(() => {
      for (const receive of listeners) receive(arm);
    });
    expect(view.getByRole("menuitem", { name: arm.label })).toBeTruthy();
    expect(view.container.querySelector(".tile-startup")).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: arm.label }));
      await Promise.resolve();
    });
    expect(confirm).toHaveBeenCalledExactlyOnceWith(arm);
    expect(view.queryByRole("menu")).toBeNull();
    expect(view.container.querySelectorAll(".tile-startup")).toHaveLength(1);
    await act(async () => {
      operation.resolve(undefined);
      await operation.promise;
    });
  },
);

test("a preparation error before main starts a sharing-capable launch keeps a failure tile", async () => {
  const view = await slowLaunch(false, true, false, false);
  expect(view.container.querySelector(".tile-startup")).toBeNull();
  await act(async () => {
    view.fail(new Error("foom-error:operation-failed"));
    await Promise.resolve();
  });
  expect(view.container.querySelectorAll('.tile-startup[data-failed="true"]')).toHaveLength(1);
  expect(view.getByText("Unable to launch session.")).toBeTruthy();
  expect(view.queryByRole("menu")).toBeNull();
});
