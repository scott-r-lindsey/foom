import { mock, start, invokeWindow, newWindow, forgeUi } from "./main-fixture";
import { expect, test, vi } from "vitest";
import type { MoveContent } from "../../../src/shared/windows";

async function accept(target: number, before?: () => void) {
  let request: unknown;
  await vi.waitFor(() => {
    request = mock.instances[target]?.webContents.send.mock.calls.findLast(
      ([channel]) => channel === "windows:prepare-move",
    )?.[1];
    expect(typeof request).toBe("string");
  });
  mock.instances[target]?.webContents.send.mockClear();
  before?.();
  await invokeWindow(target, "windows:move-ready", request, true);
  return request;
}

test("window move wiring transfers reservations before committing a destination identity", async () => {
  await start();
  await newWindow();
  await invokeWindow(0, "windows:sync", ["t1"]);
  const token = await invokeWindow(0, "windows:begin-drag", { kind: "terminal", id: "t1" });
  const dropping = invokeWindow(1, "windows:drop", token, { tile: "target", zone: "down" });
  const request = await accept(1);
  await dropping;
  expect(mock.terminals.detachView).toHaveBeenCalledWith("t1", mock.window.webContents);
  expect(mock.window.webContents.send).toHaveBeenCalledWith("windows:removed", "t1");
  expect(mock.instances[1]?.webContents.send).toHaveBeenCalledWith("windows:finish-move", request, {
    kind: "terminal",
    id: "t1",
  });
  expect(await invokeWindow(1, "windows:views")).toEqual([{ id: "t1", window: 0 }]);
  await expect(
    invokeWindow(0, "windows:begin-drag", { kind: "terminal", id: "t1" }),
  ).rejects.toThrow();
  mock.workspace.ownsSession.mockReturnValueOnce(false);
  await expect(
    invokeWindow(0, "windows:begin-drag", { kind: "terminal", id: "unknown" }),
  ).rejects.toThrow();
  // Unshown, app-owned sessions may originate from the local sidebar too.
  const hidden = invokeWindow(0, "windows:move", { kind: "terminal", id: "t2" }, 2);
  await accept(1);
  await hidden;
  expect(await invokeWindow(1, "windows:views")).toEqual([
    { id: "t1", window: 0 },
    { id: "t2", window: 0 },
  ]);
});

test("preview moves reuse the pop-out transfer and reject a vanished destination host", async () => {
  await start();
  await newWindow();
  const { previewHosts } = await import("../../../src/main/wiring/application");
  const source = previewHosts.get(1),
    target = previewHosts.get(2);
  if (!source || !target) throw new Error("Missing preview hosts");
  const id = "a".repeat(32);
  source.registry.records.set(id, {
    id,
    worktree: "/repo",
    relativePath: "plan.md",
    network: false,
  });
  const content: MoveContent = { kind: "preview", id };
  const transfer = vi.spyOn(source, "moveTo");
  const moving = invokeWindow(0, "windows:move", content, 2);
  await accept(1);
  let placement: unknown;
  await vi.waitFor(() => {
    placement = mock.instances[1]?.webContents.send.mock.calls.findLast(
      ([channel]) => channel === "preview:place",
    )?.[1];
    expect(typeof placement).toBe("string");
  });
  await invokeWindow(1, "preview:placed", placement, id, "sidebar");
  await moving;
  expect(transfer).toHaveBeenCalledWith(id, target, expect.any(Function));
  previewHosts.delete(2);
  const missing = invokeWindow(0, "windows:move", content, 2);
  await accept(1);
  await expect(missing).rejects.toThrow();
  await expect(invokeWindow(1, "windows:begin-drag", content)).rejects.toThrow();
});

test("a destroyed target and a racing reservation refusal abort before destination placement", async () => {
  await start();
  await newWindow();
  const target = mock.instances[1];
  if (!target) throw new Error("Missing target");
  const closed = invokeWindow(0, "windows:move", { kind: "terminal", id: "t1" }, 2);
  await accept(1, () => {
    target.isDestroyed.mockReturnValue(true);
  });
  await expect(closed).rejects.toThrow();
  target.isDestroyed.mockReturnValue(false);
  const { TerminalViews } = await import("../../../src/main/window/terminal-views");
  vi.spyOn(TerminalViews.prototype, "transfer").mockReturnValueOnce(false);
  const raced = invokeWindow(0, "windows:move", { kind: "terminal", id: "t1" }, 2);
  await accept(1);
  await expect(raced).rejects.toThrow();
  expect(mock.terminals.detachView).not.toHaveBeenCalled();
  mock.window.webContents.isDestroyed.mockReturnValue(true);
  const token = await invokeWindow(1, "windows:begin-drag", { kind: "terminal", id: "t2" });
  mock.window.isDestroyed.mockReturnValue(true);
  await invokeWindow(1, "windows:end-drag", token);
  mock.window.isDestroyed.mockReturnValue(false);
  mock.window.webContents.isDestroyed.mockReturnValue(false);
});

test("archived sessions without a host screen cannot register a drag or move", async () => {
  forgeUi.rows = [
    {
      id: "t1",
      kind: "agent",
      agent: "claude",
      repository: "/repo",
      worktree: "/tree",
      branch: "feature",
      attention: "hooks",
      state: null,
      dormant: true,
      exited: true,
    },
  ];
  await start();
  await newWindow();
  const content: MoveContent = { kind: "terminal", id: "t1" };
  await expect(invokeWindow(0, "windows:begin-drag", content)).rejects.toThrow();
  await expect(invokeWindow(0, "windows:move", content, 2)).rejects.toThrow();
  const row = forgeUi.rows[0];
  if (!row) throw new Error("Missing session");
  row.dormant = false;
  const token = await invokeWindow(0, "windows:begin-drag", content);
  expect(typeof token).toBe("string");
  await invokeWindow(0, "windows:end-drag", token);
});

for (const afterCommit of [false, true])
  test(`terminal wiring failure ${afterCommit ? "after" : "before"} reservation commit finishes the correct placement`, async () => {
    await start();
    await newWindow();
    await invokeWindow(0, "windows:sync", ["t1"]);
    const item: MoveContent = { kind: "terminal", id: "t1" };
    if (afterCommit) {
      mock.window.webContents.send.mockImplementation((channel) => {
        if (channel === "windows:removed") throw new Error("notification unavailable");
      });
    } else
      mock.terminals.detachView.mockImplementationOnce(() => {
        throw new Error("detach unavailable");
      });
    const moving = invokeWindow(0, "windows:move", item, 2);
    const request = await accept(1);
    await expect(moving).rejects.toThrow("foom-error:operation-failed");
    expect(mock.instances[1]?.webContents.send).toHaveBeenCalledWith(
      "windows:finish-move",
      request,
      afterCommit ? item : null,
    );
    await expect(invokeWindow(afterCommit ? 1 : 0, "windows:begin-drag", item)).resolves.toEqual(
      expect.any(String),
    );
    await expect(invokeWindow(afterCommit ? 0 : 1, "windows:begin-drag", item)).rejects.toThrow();
  });
