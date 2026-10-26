import { describe, expect, it, vi } from "vitest";
import type { OrchestrationHost } from "../../../../src/main/control/orchestration.d";
import type { ReviewLoops } from "../../../../src/main/control/review-loops";
import { ReviewEffects } from "../../../../src/main/control/review-effects";
import { ControlError } from "../../../../src/node-common/control-validation";
import { automationFixture } from "./automation-helpers";

function fixture() {
  const h = automationFixture();
  const host = {
    terminals: vi.fn<OrchestrationHost["terminals"]>(() => [h.row]),
    reviewSnapshot: vi.fn(() => Promise.resolve({ head: "head", digest: "same" })),
    stop: vi.fn(() => Promise.resolve(true)),
    launch: vi.fn<OrchestrationHost["launch"]>(() => Promise.resolve("reviewer")),
    saveHandoffs: vi.fn(async () => {}),
    place: vi.fn(),
  };
  const loops = {
    view: vi.fn<ReviewLoops["view"]>(() => ({ ...h.state })),
    reviewReady: vi.fn(() => true),
    attach: vi.fn(),
    stop: vi.fn(),
  };
  const effects = new ReviewEffects(h.authority, host, () => loops);
  effects.bind("author", h.actor, h.operations);
  return { ...h, host, loops, effects };
}

describe("isolated review effects", () => {
  it("writes stop intent, then snapshots and revalidates before signaling", async () => {
    const h = fixture();
    h.host.stop.mockImplementation(() => {
      expect(h.persist.mock.calls.at(-1)?.[0].operation).toMatchObject({
        action: "stop",
        status: "running",
      });
      expect(h.owned.validate).toHaveBeenCalledOnce();
      expect(h.host.reviewSnapshot).toHaveBeenCalledWith("/repo", "/repo/child", "identity");
      return Promise.resolve(true);
    });
    expect(await h.effects.stop("author", () => true)).toBe("stopped");
    expect(h.owned.note).toHaveBeenCalledWith(expect.objectContaining({ status: "succeeded" }));
  });

  it("cancels changed completion evidence without signaling or retrying", async () => {
    const h = fixture();
    expect(await h.effects.stop("author", () => false)).toBe("changed");
    expect(h.host.stop).not.toHaveBeenCalled();
    expect(h.owned.note).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
  });

  it("refuses a stop after authority is revoked during durable intent", async () => {
    const h = fixture();
    h.owned.validate.mockImplementation(() => {
      throw new ControlError("forbidden");
    });
    await expect(h.effects.stop("author", () => true)).rejects.toMatchObject({ code: "forbidden" });
    expect(h.host.stop).not.toHaveBeenCalled();
    expect(h.owned.note).toHaveBeenCalledWith(expect.objectContaining({ status: "indeterminate" }));
  });

  it("waits for capacity without writing launch intent", async () => {
    const h = fixture();
    h.authority.capacity.mockReturnValue(false);
    expect(await h.effects.step("author", true, "review")).toBeUndefined();
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.authority.reserve).not.toHaveBeenCalled();
  });

  it("releases the reservation when saving durable state fails, without launching", async () => {
    const h = fixture();
    h.host.saveHandoffs.mockRejectedValue(new Error("disk"));
    await expect(h.effects.step("author", true, "review")).rejects.toThrow("disk");
    expect(h.host.launch).not.toHaveBeenCalled();
    expect(h.reservation.release).toHaveBeenCalledOnce();
    expect(h.authority.released).toHaveBeenCalledOnce();
    expect(h.owned.note).toHaveBeenCalledWith(expect.objectContaining({ status: "indeterminate" }));
  });

  it("rechecks authority again in the host's pre-spawn callback", async () => {
    const h = fixture();
    h.host.launch.mockImplementation((...args) => {
      // The host owns provider preparation; the callback is the final spawn gate.
      const step = args[6];
      h.owned.validate.mockImplementation(() => {
        throw new ControlError("forbidden");
      });
      step?.validate();
      return Promise.resolve("reviewer");
    });
    await expect(h.effects.step("author", true, "review")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(h.reservation.attach).not.toHaveBeenCalled();
    expect(h.reservation.release).toHaveBeenCalledOnce();
  });

  it("retires removed runs and stops remaining loops on disposal", async () => {
    const h = fixture();
    h.effects.bind("removed", h.actor, h.operations);
    h.effects.removed("removed");
    await expect(h.effects.snapshot("removed")).rejects.toMatchObject({ code: "forbidden" });
    h.effects.dispose();
    expect(h.loops.stop).toHaveBeenCalledExactlyOnceWith("author");
  });
  it.each(["phase", "round"] as const)(
    "refuses stop when the loop %s changes after intent",
    async (field) => {
      const h = fixture();
      h.loops.view.mockReturnValueOnce({ ...h.state }).mockReturnValue({
        ...h.state,
        ...(field === "phase" ? { phase: "escalated" } : { round: 2 }),
      });
      await expect(h.effects.stop("author", () => true)).rejects.toMatchObject({
        code: "conflict",
      });
      expect(h.host.stop).not.toHaveBeenCalled();
    },
  );

  it("refuses effects for forgotten runs and unavailable snapshot capabilities", async () => {
    const h = fixture();
    h.effects.removed("author");
    await expect(h.effects.stop("author", () => true)).rejects.toMatchObject({ code: "forbidden" });
    await expect(h.effects.step("author", true, "review")).rejects.toMatchObject({
      code: "forbidden",
    });
    const effects = new ReviewEffects(
      h.authority,
      {
        terminals: h.host.terminals,
        stop: h.host.stop,
        launch: h.host.launch,
      },
      () => h.loops,
    );
    effects.bind("author", h.actor, h.operations);
    await expect(effects.snapshot("author")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("refuses a step whose author disappeared", async () => {
    const h = fixture();
    h.host.terminals.mockReturnValue([]);
    await expect(h.effects.step("author", true, "review")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("waits if capacity is lost at reservation, without recording launch intent", async () => {
    const h = fixture();
    h.authority.reserve.mockReturnValue(undefined);
    expect(await h.effects.step("author", true, "review")).toBeUndefined();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("refuses overlapping worktree processes but permits a dormant author resume", async () => {
    const h = fixture();
    h.row.exited = false;
    await expect(h.effects.step("author", false, "fix")).rejects.toMatchObject({
      code: "conflict",
    });
    expect(h.persist).not.toHaveBeenCalled();
    h.row.dormant = true;
    delete h.row.conversationId;
    h.host.launch.mockResolvedValue("author");
    expect(await h.effects.step("author", false, "fix")).toBe("author");
    expect(h.host.launch.mock.calls.at(-1)?.[6]?.resume).toEqual({
      id: "author",
      conversationId: "",
    });
    expect(h.reservation.exited).toHaveBeenCalledWith(false);
    expect(h.authority.resumed).toHaveBeenCalledWith("author");
  });

  it("stops an already-spawned reviewer when authority ends during launch", async () => {
    const h = fixture();
    h.host.launch.mockImplementation(() => {
      h.owned.active.mockReturnValue(false);
      return Promise.resolve("reviewer");
    });
    await h.effects.step("author", true, "review");
    expect(h.host.stop).toHaveBeenCalledExactlyOnceWith("reviewer");
    expect(h.host.place).not.toHaveBeenCalled();
    expect(h.reservation.release).toHaveBeenCalledOnce();
  });

  it("releases a failed launch intent and preserves the original stop error if outcome audit also fails", async () => {
    const h = fixture();
    h.persist.mockRejectedValue(new Error("audit"));
    await expect(h.effects.step("author", true, "review")).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(h.reservation.release).toHaveBeenCalledOnce();
    const stopped = fixture();
    stopped.host.stop.mockImplementation(() => {
      stopped.persist.mockRejectedValue(new Error("outcome audit"));
      return Promise.reject(new Error("stop"));
    });
    await expect(stopped.effects.stop("author", () => true)).rejects.toThrow("stop");
  });
});

it("keeps reviewer selections separate from the author's resumed selection", async () => {
  const h = fixture();
  h.row.selection = { model: "author-model", effort: "high" };
  h.state.model = "review-model";
  h.state.effort = "low";
  await h.effects.step("author", true, "review");
  expect(h.host.launch.mock.calls.at(-1)?.[6]?.selection).toEqual({
    model: "review-model",
    effort: "low",
  });
  h.state.phase = "fixing";
  await h.effects.step("author", false, "fix");
  expect(h.host.launch.mock.calls.at(-1)?.[6]?.selection).toEqual({
    model: "author-model",
    effort: "high",
  });
});
