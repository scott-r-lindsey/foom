import { expect, it, vi } from "vitest";
import type { Principal } from "../../../../src/main/control/types";
import type { AgentPreview } from "../../../../src/main/control/previews";
import { previewBackend } from "../../../../src/main/previews/control-backend";
import { PreviewRegistry } from "../../../../src/main/previews/registry";
const actor: Principal = {
  generation: "g",
  terminalId: "terminal",
  sessionId: "session",
  role: "agent",
  parentId: null,
  worktree: "/tree",
  repository: "/tree",
};
const preview: AgentPreview = {
  owner: "g",
  previewId: "a".repeat(32),
  session: "session",
  worktree: "/tree",
  path: "plan.md",
  real: "/tree/plan.md",
  kind: "markdown",
};
it("targets only the opener's selected host; sidebar registration never requests a tile", async () => {
  const host = {
    registry: new PreviewRegistry("unused"),
    open: vi.fn(() => Promise.resolve(preview.previewId)),
    close: vi.fn(() => Promise.resolve()),
    visible: vi.fn(() => true),
    placed: vi.fn(),
  };
  const place = vi.fn(() => Promise.resolve("landing" as const));
  const board = vi.fn(() => 2);
  const backend = previewBackend(new Map([[2, host]]), new Map([[2, { place }]]), board);
  expect(await backend.open(actor, preview, false)).toBe("landing");
  expect(board).toHaveBeenCalledWith("terminal");
  expect(host.open).toHaveBeenCalledWith("/tree", "plan.md", { id: preview.previewId });
  place.mockClear();
  expect(await backend.open(actor, preview, true)).toBe("sidebar");
  expect(place).not.toHaveBeenCalled();
  expect(backend.has(preview.previewId)).toBe(false);
  host.registry.records.set(preview.previewId, {
    id: preview.previewId,
    worktree: "/tree",
    relativePath: "plan.md",
    network: false,
  });
  expect(backend.has(preview.previewId)).toBe(true);
  expect(backend.visible(preview.previewId)).toBe(true);
  host.visible.mockReturnValue(false);
  expect(backend.visible(preview.previewId)).toBe(false);
  await backend.close(preview.previewId);
  expect(host.close).toHaveBeenCalledWith(preview.previewId);
  host.close.mockClear();
  await backend.close("missing");
  expect(host.close).not.toHaveBeenCalled();
  expect(
    await previewBackend(new Map([[2, host]]), new Map(), board).open(actor, preview, false),
  ).toBe("sidebar");
});
it("refuses missing boards and hosts without creating a preview", async () => {
  for (const board of [() => undefined, () => 3])
    await expect(
      previewBackend(new Map(), new Map(), board).open(actor, preview, false),
    ).rejects.toMatchObject({ code: "unavailable" });
});
