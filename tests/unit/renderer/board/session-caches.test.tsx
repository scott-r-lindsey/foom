import { agent, mock, settle, verdict } from "./app-board-fixture";
// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { createAppSource } from "../../../../src/renderer/board/live-board-source";

test.each(["close", "inventory"] as const)(
  "%s releases every closed session cache",
  async (removal) => {
    const spy = vi.spyOn(Map.prototype, "set");
    const source = createAppSource();
    const off = source.connect?.();
    try {
      await settle();
      for (let i = 0; i < 200; i++) {
        const id = `cache-session-${String(i)}`;
        mock.workspace.mockResolvedValue({ repositories: [], terminals: [agent(id, verdict(id))] });
        mock.changed?.();
        await settle();
        mock.state?.(verdict(id, 200));
        mock.execution?.({
          terminalId: id,
          launch: 1,
          revision: 1,
          turn: 1,
          phase: "exited",
          from: "working",
          to: "exited",
          source: "exit",
          at: 200,
        });
        mock.activity?.([{ id, rate: 100 }]);
        mock.exit?.(id, 0);
        mock.workspace.mockResolvedValue({ repositories: [], terminals: [] });
        if (removal === "close") await source.sidebarCommand?.({ kind: "close", id });
        else {
          mock.changed?.();
          await settle();
        }
      }
      const caches = new Set(
        spy.mock.contexts.filter((cache, index): cache is Map<unknown, unknown> => {
          const key: unknown = spy.mock.calls[index]?.[0];
          return (
            cache instanceof Map && typeof key === "string" && key.startsWith("cache-session-")
          );
        }),
      );
      // Include temporary projection maps: none may retain lifetime session history.
      expect(Math.max(...[...caches].map((cache) => cache.size))).toBeLessThanOrEqual(1);
      const activity = vi.fn();
      source.subscribeActivity(activity)();
      expect(activity).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      off?.();
    }
  },
);

test("pre-inventory evidence stays bounded and survives delayed snapshots until its first appearance", async () => {
  const source = createAppSource();
  const off = source.connect?.();
  await settle();
  for (let i = 0; i < 600; i++) {
    const id = `pending-${String(i)}`;
    mock.state?.(verdict(id));
    mock.execution?.({
      terminalId: id,
      launch: 1,
      revision: 1,
      turn: 1,
      phase: "exited",
      from: "working",
      to: "exited",
      source: "exit",
      at: 200,
    });
    mock.exit?.(id, 3);
    mock.activity?.([{ id, rate: 100 }]);
  }
  mock.changed?.(); // An inventory requested before these launches may omit them.
  await settle();
  const activity = vi.fn();
  source.subscribeActivity(activity)();
  expect(activity.mock.calls[0]?.[0]).toHaveLength(256);
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [agent("pending-0"), agent("pending-599")],
  });
  mock.changed?.();
  await settle();
  expect(source.getSnapshot()[0]).toMatchObject({ id: "pending-0", state: "quiet_ok", rate: 0 });
  expect(source.getSnapshot()[1]).toMatchObject({
    id: "pending-599",
    state: "failed",
    exited: true,
    execution: { phase: "exited" },
    rate: 100,
  });
  mock.sidebarCommand.mockRejectedValueOnce(new Error("close failed"));
  await expect(source.sidebarCommand?.({ kind: "close", id: "pending-599" })).rejects.toThrow(
    "close failed",
  );
  mock.changed?.();
  await settle();
  expect(source.getSnapshot()[1]).toMatchObject({
    id: "pending-599",
    state: "failed",
    exited: true,
  });
  off?.();
});
