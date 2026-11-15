import { mkdtemp, rm, rename, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DialogContent } from "../../../../src/shared/confirmation";
import { describe, expect, it, vi } from "vitest";
import { RepositorySetup } from "../../../../src/main/setup/repository-setup";
import {
  setupDigest,
  setupCatalogDigest,
} from "../../../../src/node-common/repository-setup-digest";
import type { RepositorySetupDependencies } from "../../../../src/main/setup/repository-setup";
import type {
  RepositorySetupAction,
  SetupApproval,
  SetupCheck,
} from "../../../../src/shared/repository-setup.d";
const draft = JSON.stringify({
  requirements: [
    {
      kind: "toolchain",
      id: "node",
      tool: "node",
      version: "24.x",
      purpose: "Build tooling",
      sources: ["package.json"],
    },
  ],
  evidence: [],
});
function fixture() {
  let identity = "registration-1";
  let content = "original";
  let state: SetupCheck["items"][number]["state"] = "met";
  let present = true;
  let hosts = [{ host: "build", codeFolder: "/code" }];
  let approvals: readonly SetupApproval[] = [];
  const deps: RepositorySetupDependencies = {
    repositories: () => (present ? [{ path: "/repo" }] : []),
    identity: () => {
      if (!present) throw new Error("Removed");
      return identity;
    },
    hosts: () => hosts,
    sources: vi.fn<RepositorySetupDependencies["sources"]>((_repo, checkout) => {
      const files = [{ path: "package.json", digest: setupDigest(content) }];
      return Promise.resolve({
        checkout: checkout ?? "/repo",
        head: "a".repeat(40),
        sources: { files, fingerprint: setupDigest(files) },
      });
    }),
    check: vi.fn<RepositorySetupDependencies["check"]>(() =>
      Promise.resolve({
        platform: { distro: "debian", os: "linux", arch: "x64", nodeAbi: true },
        items: [{ id: "node", state }],
      }),
    ),
    save: vi.fn<RepositorySetupDependencies["save"]>((value) => {
      approvals = value;
      return Promise.resolve();
    }),
  };
  const setup = new RepositorySetup(deps);
  const confirm = vi.fn<(content: DialogContent) => Promise<boolean>>(() => Promise.resolve(true));
  const launch = vi.fn(() => Promise.resolve("terminal-1"));
  const abort = new AbortController();
  const act = (input: RepositorySetupAction, scope = "board") =>
    setup.action(scope, input, confirm, launch, abort.signal);
  const approve = async () => {
    const reviewed = await act({ action: "review", repository: "/repo", draft });
    if (!reviewed.review) throw new Error("No review");
    await act({ action: "approve", token: reviewed.review.token });
  };
  return {
    setup,
    deps,
    act,
    approve,
    confirm,
    launch,
    abort,
    saved: () => approvals,
    change: (value = "changed") => {
      content = value;
    },
    state: (value: typeof state) => {
      state = value;
    },
    identity: () => {
      identity = "registration-2";
    },
    remove: () => {
      present = false;
    },
    hosts: () => {
      hosts = [];
    },
  };
}
describe("main-owned repository setup approval and admission", () => {
  it("revokes reviews when editing or cancelling, including an in-flight source read", async () => {
    const f = fixture();
    const review = await f.act({ action: "review", repository: "/repo", draft });
    if (!review.review) throw new Error("No review");
    await f.act({ action: "cancel-review", keepDraft: true });
    await expect(f.act({ action: "approve", token: review.review.token })).rejects.toThrow(
      "expired",
    );
    const sources = vi.mocked(f.deps.sources).getMockImplementation();
    if (!sources) throw new Error("Missing fixture source reader");
    let finish: () => void = () => {};
    vi.mocked(f.deps.sources).mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return sources(...args);
    });
    const pending = f.act({ action: "review", repository: "/repo", draft });
    await f.act({ action: "cancel-review", keepDraft: false });
    finish();
    await expect(pending).rejects.toThrow("changed");
    expect(f.saved()).toEqual([]);
  });
  it("keeps unsupported toolchain suggestions unresolved until explicitly removed", async () => {
    const f = fixture();
    const unknown = {
      requirements: [
        {
          kind: "toolchain",
          id: "node",
          tool: "ruby",
          version: "24.x",
          purpose: "Build tooling",
          sources: [],
        },
      ],
      evidence: [],
    };
    const first = await f.act({
      action: "review",
      repository: "/repo",
      draft: JSON.stringify(unknown),
    });
    if (!first.review) throw new Error("No review");
    expect(first.review.unresolved).toHaveLength(1);
    expect(first.review.list.requirements).toEqual([]);
    await expect(f.act({ action: "approve", token: first.review.token })).rejects.toThrow(
      "unsupported",
    );
    await f.act({ action: "cancel-review", keepDraft: true });
    const removed = await f.act({
      action: "review",
      repository: "/repo",
      draft: '{"requirements":[],"evidence":[]}',
    });
    expect(removed.review?.removed).toEqual(["node"]);
  });
  it("has no prerequisite without approval and review never installs", async () => {
    const f = fixture();
    expect((await f.act({ action: "list" })).rows.every((row) => row.state === "no-list")).toBe(
      true,
    );
    (await f.setup.admit(null, "/repo", "/repo")).validate();
    const reviewed = await f.act({ action: "review", repository: "/repo", draft });
    expect(reviewed.review).toMatchObject({ catalog: setupCatalogDigest, revision: 0 });
    expect(f.saved()).toEqual([]);
    expect(f.launch).not.toHaveBeenCalled();
    await f.approve();
    expect(f.saved()[0]).toMatchObject({ revision: 1 });
    expect(f.launch).not.toHaveBeenCalled();
    await f.setup.admit(null, "/repo", "/repo");
    f.state("missing");
    await expect(f.setup.admit(null, "/repo", "/repo")).rejects.toMatchObject({
      reason: "repository_setup_missing",
    });
  });
  it("binds reviews to their board, active revision and current bytes", async () => {
    const f = fixture();
    const review = await f.act({ action: "review", repository: "/repo", draft });
    if (!review.review) throw new Error("No review");
    await expect(f.act({ action: "approve", token: review.review.token }, "other")).rejects.toThrow(
      "expired",
    );
    f.change();
    await expect(f.act({ action: "approve", token: review.review.token })).rejects.toThrow(
      "changed",
    );
    expect(f.saved()).toEqual([]);
    await f.approve();
    const first = await f.act({ action: "review", repository: "/repo" });
    const second = await f.act({ action: "review", repository: "/repo" }, "second");
    if (!first.review || !second.review) throw new Error("No review");
    await f.act({ action: "approve", token: second.review.token }, "second");
    await expect(f.act({ action: "approve", token: first.review.token })).rejects.toThrow(
      "expired",
    );
    expect(f.saved()[0]?.revision).toBe(2);
  });
  it("retains the previous approval and editable review after a failed save", async () => {
    const f = fixture();
    await f.approve();
    const review = await f.act({ action: "review", repository: "/repo" });
    if (!review.review) throw new Error("No review");
    vi.mocked(f.deps.save).mockRejectedValueOnce(new Error("Disk full"));
    await expect(f.act({ action: "approve", token: review.review.token })).rejects.toThrow(
      "Disk full",
    );
    expect(f.saved()[0]?.revision).toBe(1);
    await f.act({ action: "approve", token: review.review.token });
    expect(f.saved()[0]?.revision).toBe(2);
  });
  it("refuses stale, failed, unsupported and changed identities at admission", async () => {
    const f = fixture();
    await f.approve();
    const admitted = await f.setup.admit(null, "/repo", "/repo");
    f.change();
    await expect(f.setup.admit("build", "/repo", "/repo")).rejects.toMatchObject({
      reason: "repository_setup_changed",
    });
    f.change("original");
    for (const state of ["unable", "manual"] as const) {
      f.state(state);
      await expect(f.setup.admit(null, "/repo", "/repo")).rejects.toMatchObject({
        reason: state === "manual" ? "repository_setup_manual" : "repository_setup_unavailable",
      });
    }
    f.identity();
    expect(() => {
      admitted.validate();
    }).toThrow();
    expect((await f.act({ action: "list" })).rows[0]?.state).toBe("review-needed");
    await expect(f.setup.admit(null, "/repo", "/repo")).rejects.toMatchObject({
      reason: "repository_setup_changed",
    });
  });
  it("scope cancellation, source failures and absence cannot grant approval", async () => {
    const f = fixture();
    const review = await f.act({ action: "review", repository: "/repo", draft });
    if (!review.review) throw new Error("No review");
    f.setup.cancelScope("board");
    await expect(f.act({ action: "approve", token: review.review.token })).rejects.toThrow();
    vi.mocked(f.deps.sources).mockResolvedValueOnce(undefined);
    await expect(f.act({ action: "review", repository: "/repo", draft })).rejects.toThrow();
    await f.approve();
    vi.mocked(f.deps.sources).mockResolvedValueOnce(undefined);
    await expect(f.setup.admit(null, "/repo", "/repo")).rejects.toThrow();
    vi.mocked(f.deps.sources).mockRejectedValueOnce(new Error("unreachable"));
    expect((await f.setup.check("board", "build", "/repo")).state).toBe("unable");
  });
  it("removal confirms prerequisite removal and never uninstalls", async () => {
    const f = fixture();
    await f.approve();
    f.confirm.mockResolvedValueOnce(false);
    await f.act({ action: "remove", repository: "/repo" });
    expect(f.saved()).toHaveLength(1);
    await f.act({ action: "remove", repository: "/repo" });
    expect(f.saved()).toEqual([]);
    expect(f.confirm.mock.calls[0]?.[0].detail).toContain("launch prerequisite");
    expect(f.launch).not.toHaveBeenCalled();
  });
  it("Set up requires a fresh matching plan and excludes competing board runs", async () => {
    const f = fixture();
    await f.approve();
    f.state("missing");
    const checked = await f.act({ action: "check", repository: "/repo", host: "build" });
    const token = checked.rows.find((row) => row.host === "build")?.token;
    if (!token) throw new Error("No plan");
    await expect(f.act({ action: "run", token }, "other")).rejects.toThrow();
    const result = await f.act({ action: "run", token });
    expect(result.recipeSession).toBe("terminal-1");
    expect(f.launch).toHaveBeenCalledTimes(1);
    const rechecked = await f.act({ action: "check", repository: "/repo", host: "build" });
    const second = rechecked.rows.find((row) => row.host === "build")?.token;
    if (!second) throw new Error("No plan");
    await expect(f.act({ action: "run", token: second })).rejects.toThrow("running");
  });
  it("changed plans, probe/save failures and forgotten hosts refuse execution", async () => {
    const f = fixture();
    await f.approve();
    f.state("missing");
    const checked = await f.act({ action: "check", repository: "/repo", host: "build" });
    const token = checked.rows.find((row) => row.host === "build")?.token;
    if (!token) throw new Error("No plan");
    f.state("met");
    await expect(f.act({ action: "run", token })).rejects.toThrow("changed");
    expect(f.launch).not.toHaveBeenCalled();
    vi.mocked(f.deps.save).mockRejectedValueOnce(new Error("disk"));
    expect((await f.setup.check("board", "build", "/repo")).failure).toBe("save-failed");
    await f.setup.forgetHost("build");
    f.hosts();
    await expect(f.setup.check("board", "build", "/repo")).rejects.toThrow();
  });
});

it("persists approvals and observations while rechecking admission after restart", async () => {
  const profile = await mkdtemp(join(tmpdir(), "repository-setup-profile-"));
  try {
    const f = fixture();
    const service = await RepositorySetup.open(profile, f.deps);
    const action = (input: RepositorySetupAction) =>
      service.action("board", input, f.confirm, f.launch, f.abort.signal);
    const reviewed = await action({ action: "review", repository: "/repo", draft });
    if (!reviewed.review) throw new Error("No review");
    await action({ action: "approve", token: reviewed.review.token });
    await action({ action: "check", repository: "/repo", host: null });
    const reopened = await RepositorySetup.open(profile, f.deps);
    expect(reopened.state("other").rows.find((row) => row.host === null)).toMatchObject({
      state: "met",
      revision: 1,
    });
    f.state("missing");
    await expect(reopened.admit(null, "/repo", "/repo")).rejects.toMatchObject({
      reason: "repository_setup_missing",
    });
    expect(reopened.state("other").rows.every((row) => !row.token)).toBe(true);
    await reopened.forgetRepository("/repo");
    expect(reopened.state("other").rows.every((row) => row.state === "no-list")).toBe(true);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
it("failed atomic persistence retains the active revision and permits a review retry", async () => {
  const profile = await mkdtemp(join(tmpdir(), "repository-setup-save-"));
  try {
    const f = fixture();
    const service = await RepositorySetup.open(profile, f.deps);
    const action = (input: RepositorySetupAction) =>
      service.action("board", input, f.confirm, f.launch, f.abort.signal);
    const initial = await action({ action: "review", repository: "/repo", draft });
    if (!initial.review) throw new Error("No review");
    await action({ action: "approve", token: initial.review.token });
    const next = await action({ action: "review", repository: "/repo" });
    if (!next.review) throw new Error("No review");
    const file = join(profile, "repository-setup", "state.json");
    const backup = join(profile, "repository-setup", "before.json");
    await rename(file, backup);
    await mkdir(file);
    await expect(action({ action: "approve", token: next.review.token })).rejects.toThrow();
    expect(service.state("board").rows[0]?.revision).toBe(1);
    await rm(file, { recursive: true });
    await rename(backup, file);
    await action({ action: "approve", token: next.review.token });
    expect(service.state("board").rows[0]?.revision).toBe(2);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
it("refuses corrupt stored authority instead of silently dropping a prerequisite", async () => {
  const profile = await mkdtemp(join(tmpdir(), "repository-setup-corrupt-"));
  try {
    const f = fixture();
    await f.approve();
    const approved = f.saved()[0];
    if (!approved) throw new Error("No approval");
    const directory = join(profile, "repository-setup");
    await mkdir(directory, { mode: 0o700 });
    for (const value of [
      null,
      {},
      { approvals: [{}] },
      { approvals: [{ ...approved, digest: "wrong" }] },
      { approvals: [{ ...approved, catalog: "wrong" }] },
      { approvals: [{ ...approved, sources: {} }] },
      {
        approvals: [{ ...approved, sources: { ...approved.sources, fingerprint: "a".repeat(64) } }],
      },
    ]) {
      await writeFile(join(directory, "state.json"), JSON.stringify(value), { mode: 0o600 });
      await expect(RepositorySetup.open(profile, f.deps)).rejects.toThrow("Unable to read");
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

it("stops future setup steps on approval replacement and settles only the affected row", async () => {
  const f = fixture();
  await f.approve();
  f.state("missing");
  let finish = () => {};
  let validate = () => {};
  let signal: AbortSignal | undefined;
  const launch = vi.fn<Parameters<RepositorySetup["action"]>[3]>(
    (_host, _approval, _row, finished, cancellation, check) => {
      finish = finished;
      validate = check;
      signal = cancellation;
      check();
      return Promise.resolve("run-1");
    },
  );
  const checked = await f.act({ action: "check", repository: "/repo", host: null });
  const token = checked.rows.find((row) => row.host === null)?.token;
  if (!token) throw new Error("No plan");
  await f.setup.action("board", { action: "run", token }, f.confirm, launch, f.abort.signal);
  await f.approve();
  expect(signal?.aborted).toBe(true);
  expect(validate).toThrow();
  f.state("met");
  finish();
  await vi.waitFor(() => {
    expect(f.deps.save).toHaveBeenCalled();
  });
});

it("incomplete or duplicated host results cannot establish requirements met", async () => {
  const f = fixture();
  await f.approve();
  for (const items of [
    [],
    [{ id: "unrelated", state: "met" as const }],
    [
      { id: "node", state: "met" as const },
      { id: "node", state: "met" as const },
    ],
  ]) {
    vi.mocked(f.deps.check).mockResolvedValueOnce({
      platform: { distro: "debian", os: "linux", arch: "x64", nodeAbi: true },
      items,
    });
    expect((await f.setup.check("board", "build", "/repo")).state).toBe("unable");
  }
});

it.each(["board", "second"])(
  "concurrent row rechecks retain usable plan tokens for scope %s",
  async (scope) => {
    const f = fixture();
    await f.approve();
    f.state("missing");
    const saved = Promise.withResolvers<undefined>();
    vi.mocked(f.deps.save)
      .mockClear()
      .mockImplementationOnce(() => saved.promise);
    vi.mocked(f.deps.check).mockClear();
    const first = f.act({ action: "check", repository: "/repo", host: null });
    await vi.waitFor(() => {
      expect(f.deps.save).toHaveBeenCalledOnce();
    });
    const second = f.act({ action: "check", repository: "/repo", host: null }, scope);
    await vi.waitFor(() => {
      expect(f.deps.check).toHaveBeenCalledTimes(2);
    });
    saved.resolve(undefined);
    const [a, b] = await Promise.all([first, second]);
    const token = a.rows.find((row) => row.host === null)?.token;
    const other = b.rows.find((row) => row.host === null)?.token;
    expect(token).toBeDefined();
    expect(other).toBeDefined();
    if (scope === "board") expect(other).toBe(token);
    else expect(other).not.toBe(token);
    if (!token) throw new Error("No plan");
    await f.act({ action: "run", token });
    expect(f.launch).toHaveBeenCalledOnce();
  },
);
