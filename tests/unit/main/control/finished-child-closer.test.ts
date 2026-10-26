import type { OrchestrationHost } from "../../../../src/main/control/orchestration.d";
import { describe, expect, it, vi } from "vitest";
import { FinishedChildCloser } from "../../../../src/main/control/finished-child-closer";
import type { PullRequest } from "../../../../src/main/control/forge.d";
import { automationFixture, settleAutomation } from "./automation-helpers";

function fixture() {
  const h = automationFixture();
  const cancel = vi.fn();
  const host = {
    terminals: () => [h.row],
    close: vi.fn<OrchestrationHost["close"]>(() => Promise.resolve(true)),
    forge: {
      track: vi.fn(),
      read: vi.fn(),
      revision: () => 7,
      readSettled: vi.fn((): PullRequest | undefined => ({
        number: 1,
        state: "MERGED",
        headSha: "head",
        requiredChecks: "success",
      })),
      waitForRead: vi.fn(() => cancel),
    },
  };
  const reviews = {
    keepsStateAfterClose: vi.fn(() => true),
    verdictRecorded: vi.fn(() => true),
    unread: vi.fn(() => undefined),
  };
  const metadata = vi.fn(() => h.row.review);
  const closer = new FinishedChildCloser(
    { children: () => [{ parentId: "parent", id: "author" }], authorize: h.authority.authorize },
    host,
    reviews,
    metadata,
  );
  closer.bind(h.actor, h.operations);
  closer.observeExit("author");
  const sync = async () => {
    closer.sync();
    await settleAutomation();
  };
  return { ...h, host, reviews, closer, sync, cancel };
}

describe("isolated finished-child closer", () => {
  it("uses settled observations after exit, persists close intent, and closes once", async () => {
    const h = fixture();
    h.host.close.mockImplementation(() => {
      expect(h.owned.valid).toHaveBeenCalledOnce();
      expect(h.persist.mock.calls.at(-1)?.[0].operation).toMatchObject({
        action: "close",
        status: "running",
      });
      return Promise.resolve(true);
    });
    await h.sync();
    await h.sync();
    expect(h.host.forge.readSettled).toHaveBeenCalledWith("/repo", "/repo/child", 7);
    expect(h.host.close).toHaveBeenCalledOnce();
    expect(h.owned.note).toHaveBeenCalledWith(expect.objectContaining({ status: "succeeded" }));
  });

  it("retains a failed close and never retries on later invalidations", async () => {
    const h = fixture();
    h.host.close.mockRejectedValue(new Error("close"));
    await h.sync();
    await h.sync();
    expect(h.host.close).toHaveBeenCalledOnce();
    expect(h.owned.note).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("retains the screen after an audit failure without retrying intent", async () => {
    const h = fixture();
    h.persist.mockRejectedValue(new Error("audit"));
    await h.sync();
    await h.sync();
    expect(h.host.close).not.toHaveBeenCalled();
    expect(h.persist).toHaveBeenCalledOnce();
  });

  it("cancels if ownership changes while intent is persisted", async () => {
    const h = fixture();
    h.persist.mockImplementation(() => {
      h.owned.valid.mockReturnValue(false);
      return Promise.resolve();
    });
    await h.sync();
    expect(h.host.close).not.toHaveBeenCalled();
    expect(h.owned.note).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
  });

  it("retains the final loop participant through the review retention capability", async () => {
    const h = fixture();
    h.row.review = { ...h.state, phase: "clean", authorId: "other-author" };
    h.reviews.keepsStateAfterClose.mockReturnValue(false);
    await h.sync();
    expect(h.host.close).not.toHaveBeenCalled();
    expect(h.reviews.keepsStateAfterClose).toHaveBeenCalledWith("author", expect.any(Set));
    h.reviews.keepsStateAfterClose.mockReturnValue(true);
    await h.sync();
    expect(h.host.close).toHaveBeenCalledOnce();
    expect(h.host.forge.readSettled).not.toHaveBeenCalled();
  });

  it.each(["resume", "remove", "retire", "disable", "dispose"])(
    "retires observation interests on %s",
    async (event) => {
      const h = fixture();
      h.host.forge.readSettled.mockReturnValue(undefined);
      await h.sync();
      expect(h.host.forge.waitForRead).toHaveBeenCalledWith("/repo", "/repo/child", 7);
      if (event === "resume") h.closer.resumed("author");
      if (event === "remove") h.closer.removed("author");
      if (event === "retire") h.closer.retire("parent");
      if (event === "disable") h.closer.configure(false);
      if (event === "dispose") h.closer.dispose();
      else await h.sync();
      expect(h.cancel).toHaveBeenCalledOnce();
      expect(h.host.close).not.toHaveBeenCalled();
    },
  );
});

it.each(["live", "ownership", "ineligible", "declined"])(
  "automatic close revalidates before its effect: %s",
  async (mode) => {
    const h = fixture();
    const removed = vi.fn();
    h.host.close.mockImplementation((_id, validate, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(validate).toBeTypeOf("function");
      if (mode === "ownership") h.owned.valid.mockReturnValue(false);
      if (mode === "ineligible") h.row.exited = false;
      validate?.();
      if (mode !== "declined") removed();
      return Promise.resolve(mode !== "declined");
    });
    await h.sync();
    await h.sync();
    expect(h.host.close).toHaveBeenCalledOnce();
    expect(h.owned.note).toHaveBeenCalledWith(
      expect.objectContaining({
        status: mode === "live" ? "succeeded" : mode === "declined" ? "declined" : "failed",
      }),
    );
    expect(removed).toHaveBeenCalledTimes(mode === "live" ? 1 : 0);
  },
);
