import { mock, start, invokeWindow, newWindow } from "./main-fixture";
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
  await moving;
  expect(transfer).toHaveBeenCalledWith(id, target);
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
