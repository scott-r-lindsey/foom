// @vitest-environment jsdom
import { act, fireEvent, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { initialLayout, placeSession, saveLayout } from "../../../../src/renderer/board/tiles";
import { registerTileAreaFixture, setup } from "./tile-area-fixture";

registerTileAreaFixture();

test("worker trim follows role and takeover metadata without remounting or reattaching", () => {
  const { screen, click, data, views } = setup();
  click(0);
  const tile = screen.getByRole("region", { name: /Tile 1:/ });
  const terminal = tile.querySelector(".tile-terminal");
  const mounts = views.map((view) => view.mount.mock.calls.length);
  const opens = views.map((view) => view.open.mock.calls.length);
  expect(within(tile).queryByRole("img", { name: "Worker" })).toBeNull();
  act(() => {
    data.update("permission", {
      orchestration: { role: "child", parentId: "parent", takenOver: false },
    });
  });
  const mark = within(tile).getByRole("img", { name: "Worker" });
  expect(mark.closest(".tile-title")).toBeTruthy();
  expect(mark.querySelector("title")?.textContent).toBe("Child of parent");
  expect(mark.getAttribute("data-kind")).toBe("rx");
  const review = {
    authorId: "permission",
    agent: "claude",
    postFindings: false,
    rounds: 3,
    round: 1,
    phase: "reviewing" as const,
  };
  act(() => {
    data.update("permission", { review });
  });
  expect(within(tile).getByRole("img", { name: "Worker" })).toBe(mark);
  act(() => {
    data.update("permission", { review: { ...review, authorId: "author" } });
  });
  expect(within(tile).getByRole("img", { name: "Reviewer" })).toBe(mark);
  expect(mark.getAttribute("data-kind")).toBe("review");
  expect(within(tile).getByText("Reviewing 1/3")).toBeTruthy();
  act(() => {
    data.update("permission", { review: undefined });
  });
  const parent = data.getSnapshot()[1];
  if (!parent) throw new Error("Missing parent fixture");
  act(() => {
    data.update(parent.id, {
      id: "parent",
      orchestration: { role: "orchestrator", active: true, children: 1, history: [] },
    });
  });
  expect(mark.querySelector("title")?.textContent).toBe(`Child of ${parent.agent}`);

  act(() => {
    data.update("permission", {
      orchestration: { role: "child", parentId: "parent", takenOver: true },
    });
  });
  expect(within(tile).getByRole("img", { name: "Worker" })).toBe(mark);
  expect(mark.querySelector("title")?.textContent).toBe(`Child of ${parent.agent} · Taken over`);
  act(() => {
    data.update("permission", {
      orchestration: { role: "orchestrator", active: true, children: 0, history: [] },
    });
  });
  expect(within(tile).queryByRole("img", { name: "Worker" })).toBeNull();
  act(() => {
    data.update("permission", { orchestration: undefined });
  });
  expect(within(tile).queryByRole("img", { name: "Worker" })).toBeNull();
  expect(tile.querySelector(".tile-terminal")).toBe(terminal);
  expect(views.map((view) => view.mount.mock.calls.length)).toEqual(mounts);
  expect(views.map((view) => view.open.mock.calls.length)).toEqual(opens);
  expect(views.every((view) => view.dispose.mock.calls.length === 0)).toBe(true);
});
test("activity changes tile light brightness without remounting, and only attention has the needs-you state", () => {
  const { screen, click, data, views } = setup();
  click(0);
  const tile = screen.getByRole("region", { name: /Tile 1:/ });
  expect(tile.getAttribute("data-state")).toBe("needs_input");
  const mounts = views[0]?.mount.mock.calls.length;
  act(() => {
    data.setActivity("permission", 10000);
  });
  expect(views[0]?.mount.mock.calls.length).toBe(mounts);
  act(() => {
    data.update("permission", { state: "working" });
  });
  expect(tile.getAttribute("data-state")).toBe("working");
  act(() => {
    data.setActivity("permission", 1000);
  });
  expect(
    tile.querySelector<HTMLElement>(".board-light")?.style.getPropertyValue("--light-opacity"),
  ).not.toBe("");
});
test("waiting title bars name the count without changing terminal attachments", () => {
  const { screen, click, data, views } = setup();
  click(0);
  const tile = screen.getByRole("region", { name: /Tile 1:/ });
  const mounts = views[0]?.mount.mock.calls.length;
  act(() => {
    data.update("permission", { state: "waiting", waitingOn: 2, reason: "Waiting on 2" });
  });
  expect(tile.getAttribute("data-state")).toBe("waiting");
  expect(within(tile).getByText("Waiting on 2")).toBeTruthy();
  expect(
    within(tile).getByRole("img", { name: "Waiting on 2" }).getAttribute("data-light-state"),
  ).toBe("waiting");
  expect(views[0]?.mount.mock.calls.length).toBe(mounts);
});
test("resuming in the same row reattaches its existing controller without remounting", async () => {
  const { row, data, views } = setup();
  await act(async () => {
    fireEvent.click(row(0));
    await Promise.resolve();
  });
  const id = data.getSnapshot()[0]?.id;
  if (!id) throw new Error("Missing fixture session");
  const mounts = views[0]?.mount.mock.calls.length;
  const opens = views[0]?.open.mock.calls.length ?? 0;
  act(() => {
    data.update(id, { launchVersion: 1 });
  });
  expect(views[0]?.open.mock.calls.length).toBe(opens + 1);
  expect(views[0]?.mount.mock.calls.length).toBe(mounts);
});

test("probe chrome names its driver and keeps prompt feedback off the probe", async () => {
  const { data, screen } = setup();
  const [driver, probe] = data.getSnapshot();
  if (!driver || !probe) throw Error("Missing fixture sessions");
  act(() => {
    data.update(driver.id, { agent: "Fixture driver", config: true });
    data.update(probe.id, {
      agent: "Fixture probe",
      config: true,
      probe: true,
      probeOwner: driver.id,
      state: "needs_input",
      reason: "Trust folder?",
    });
  });
  fireEvent.click(
    screen.getByText("Fixture probe · Probe", { exact: true }).closest(".board-row") ??
      document.body,
  );
  await act(async () => {});
  const label = screen.container.querySelector(".probe-driver");
  expect(label?.textContent).toBe("Probe · Fixture driver");
  expect(label?.closest(".terminal-tile")?.querySelector(".tile-attention")).toBeNull();
  act(() => {
    data.update(driver.id, { agent: "Renamed fixture driver" });
  });
  expect(label?.textContent).toBe("Probe · Renamed fixture driver");
});

test("review state appears on the sidebar and tile without remounting its terminal", () => {
  const { screen, click, data, views } = setup();
  click(0);
  const mounts = views.map((view) => view.mount.mock.calls.length);
  const tile = screen.getByRole("region", { name: /Tile 1:/ });
  for (const phase of ["building", "reviewing", "fixing", "clean", "escalated"] as const) {
    act(() => {
      data.update("permission", {
        review: {
          authorId: "permission",
          rounds: 3,
          round: 2,
          agent: "claude",
          postFindings: false,
          phase,
          ...(phase === "escalated" ? { reason: "round cap" as const } : {}),
        },
      });
    });
    expect(tile.querySelector(`[data-review-phase="${phase}"]`)).not.toBeNull();
    expect(
      screen.container.querySelector(`.session-entry [data-review-phase="${phase}"]`),
    ).not.toBeNull();
  }
  expect(views.map((view) => view.mount.mock.calls.length)).toEqual(mounts);
});

test("saved exited rows stay in the sidebar; restoring tiles survive until failure or first frame", async () => {
  const saved = placeSession(initialLayout(), "permission");
  if (!saved) throw new Error("No layout");
  saveLayout(localStorage, saved);
  const { screen, data, views, snapshot } = setup();
  act(() => {
    data.update("permission", { dormant: true, exited: true });
  });
  expect(screen.container.querySelectorAll('.terminal-tile[data-empty="false"]')).toHaveLength(0);
  expect(screen.container.querySelector('[data-drag-session="permission"]')).toBeTruthy();
  fireEvent.click(
    screen.container.querySelector('[data-drag-session="permission"]') ?? document.body,
  );
  expect(screen.container.querySelectorAll('.terminal-tile[data-empty="false"]')).toHaveLength(0);
  // Manual resume places a fresh tile in the existing layout.
  act(() => {
    data.update("permission", { dormant: false, exited: false });
  });
  fireEvent.click(
    screen.container.querySelector('[data-drag-session="permission"]') ?? document.body,
  );
  expect(screen.container.querySelectorAll('.terminal-tile[data-empty="false"]')).toHaveLength(1);
  snapshot.firstFrame = false;
  snapshot.attaching = true;
  act(() => {
    data.update("permission", { dormant: true, exited: false });
  });
  expect(screen.container.querySelector(".tile-restoring")).toBeTruthy();
  act(() => {
    data.update("permission", { dormant: false });
  });
  expect(screen.container.querySelector(".tile-restoring")).toBeTruthy();
  snapshot.firstFrame = true;
  snapshot.attaching = false;
  act(() => {
    data.update("permission", { launchVersion: 1 });
  });
  expect(screen.container.querySelector(".tile-restoring")).toBeNull();
  expect(views[0]?.mount).toHaveBeenCalledOnce();
  act(() => {
    data.update("permission", { dormant: true, exited: true });
  });
  expect(screen.container.querySelectorAll('.terminal-tile[data-empty="false"]')).toHaveLength(0);
  await act(async () => {});
});

test("a role that could not be restored loses its saved tile without deleting its row", () => {
  const saved = placeSession(initialLayout(), "permission");
  if (!saved) throw new Error("No layout");
  saveLayout(localStorage, saved);
  const { screen, data } = setup();
  act(() => {
    data.update("permission", { roleNotRestored: true });
  });
  expect(screen.container.querySelectorAll('.terminal-tile[data-empty="false"]')).toHaveLength(0);
  expect(screen.container.querySelector('[data-drag-session="permission"]')).toBeTruthy();
  fireEvent.click(
    screen.container.querySelector('[data-drag-session="permission"]') ?? document.body,
  );
  act(() => {
    data.update("permission", { launchVersion: 2 });
  });
  expect(screen.container.querySelectorAll('.terminal-tile[data-empty="false"]')).toHaveLength(1);
});

test("saved exited rows cannot be dragged back onto the board without a host", () => {
  const { screen, data, row } = setup();
  act(() => {
    data.update("permission", { dormant: true, exited: true });
  });
  const target = screen.container.querySelector<HTMLElement>(".terminal-tile");
  if (!target) throw new Error("No tile");
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    width: 100,
    height: 100,
    right: 100,
    bottom: 100,
    toJSON: () => ({}),
  });
  vi.stubGlobal("DragEvent", MouseEvent);
  const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  fireEvent.dragStart(row(0), { dataTransfer: transfer });
  fireEvent.dragOver(target, { dataTransfer: transfer, clientX: 50, clientY: 50 });
  fireEvent.drop(target, { dataTransfer: transfer, clientX: 50, clientY: 50 });
  expect(screen.container.querySelector(".tile-drop-preview")).toBeNull();
  expect(target.dataset["empty"]).toBe("true");
  vi.unstubAllGlobals();
});

test.each(["Terminal host failed. Restart the shell to continue.", "Unable to open terminal"])(
  "attachment failure shows its status without a restore skeleton: %s",
  (status) => {
    const saved = placeSession(initialLayout(), "permission");
    if (!saved) throw new Error("No layout");
    saveLayout(localStorage, saved);
    const { screen } = setup({ status, firstFrame: false, attaching: false });
    expect(screen.container.querySelector('.terminal-tile[data-empty="false"]')).toBeTruthy();
    expect(screen.container.querySelector(".tile-restoring")).toBeNull();
    expect(screen.container.querySelector(".tile-status")?.textContent).toBe(status);
  },
);

test("terminal context menu dismisses on commands, hiding and reassignment", () => {
  const { screen, click, views } = setup();
  click(0);
  const anchor = document.body.appendChild(document.createElement("textarea"));
  const menu = {
    id: "permission",
    anchor,
    point: { x: 40, y: 40 },
    copy: undefined,
    paste: vi.fn(),
    selectAll: vi.fn(),
    clear: vi.fn(),
  };
  act(() => {
    views[0]?.context(menu);
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "Select all" }));
  expect(menu.selectAll).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu", { name: "Terminal menu" })).toBeNull();
  act(() => {
    views[0]?.context(menu);
  });
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  expect(screen.queryByRole("menu", { name: "Terminal menu" })).toBeNull();
  click(1);
  act(() => {
    views[0]?.context(menu);
  });
  expect(screen.queryByRole("menu", { name: "Terminal menu" })).toBeNull();
  anchor.remove();
});
