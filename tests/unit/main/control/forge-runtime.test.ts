import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ForgeLifecycle } from "../../../../src/main/control/forge-lifecycle";
import { ForgeRuntime } from "../../../../src/main/control/forge-runtime";
import { ForgeTracking } from "../../../../src/main/control/forge-tracking";
import { forgeProvider } from "../../../helpers/legacy-forge";
import { forgeValue } from "../../../../src/main/control/forge-mapping";
import { executeForge, resolveForgeExecutable } from "../../../../src/main/control/forge-process";
import github from "../../../../src/shared/bundled-forges/github.json";
import { parseForgeManifest } from "../../../../src/shared/forge-manifest";
import type { ForgeResponse } from "../../../../src/main/control/forge.d";
import { privateDirectory } from "../../../../src/node-common/private-files";

vi.mock("../../../../src/main/control/forge-process", () => ({
  executeForge: vi.fn(),
  resolveForgeExecutable: vi.fn(),
  ForgeExecutionError: class extends Error {
    constructor(readonly state: string) {
      super(state);
    }
  },
}));
const roots: string[] = [];
const runtimes: ForgeRuntime[] = [];
const trackers: ForgeTracking[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
  await Promise.all(trackers.splice(0).map((t) => t.close()));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  vi.resetAllMocks();
});
const remote = "https://github.com/cli/cli.git";
const context = { identity: "registered-1", validate: vi.fn(async () => {}) };
const getContext = () => Promise.resolve(context);
const settings = () => ({ forges: { github: true }, forgeHosts: { "github.com": "github" } });
function harness(cacheMs = 20000) {
  let preferences: { forges: Record<string, boolean>; forgeHosts: Record<string, string> } =
    settings();
  let path = "/fixture/bin";
  let identity = "executable-1";
  const discover = vi.fn(() => Promise.resolve(path));
  vi.mocked(resolveForgeExecutable).mockImplementation(() =>
    Promise.resolve({
      executable: "/fixture/bin/gh",
      identity,
    }),
  );
  vi.mocked(executeForge).mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  const runtime = new ForgeRuntime(() => preferences, discover, { cacheMs });
  runtimes.push(runtime);
  return {
    runtime,
    discover,
    settings: (next: typeof preferences) => {
      preferences = next;
      runtime.configure();
    },
    path: (next: string) => {
      path = next;
    },
    identity: (next: string) => {
      identity = next;
    },
  };
}
async function capture(name: string): Promise<unknown> {
  const envelope: unknown = JSON.parse(
    await readFile(`spikes/forge-manifests/fixtures/${name}.json`, "utf8"),
  );
  const stdout = forgeValue(envelope, ["stdout"]);
  if (typeof stdout !== "string") throw new Error("Missing fixture stdout");
  const value: unknown = JSON.parse(stdout);
  return value;
}

it("defaults to manifests and requires main-owned context before discovery", async () => {
  const h = harness();
  expect(await h.runtime.provider(remote)).toBeUndefined();
  expect(h.discover).not.toHaveBeenCalled();
  expect(await h.runtime.provider(remote, getContext)).toHaveProperty("batch");
  expect(h.discover).toHaveBeenCalledOnce();
  await h.runtime.close();
  expect(await h.runtime.provider(remote, getContext)).toBeUndefined();
});

it("routes only explicit enabled assignments; declarations cannot claim hosts or provide fallback", async () => {
  const h = harness();
  for (const url of ["bad", "https://unassigned.example/o/r", "https://github.com/a/b/c"])
    expect(await h.runtime.provider(url, getContext)).toBeUndefined();
  expect(await h.runtime.provider(remote)).toBeUndefined();
  h.settings({ forges: { github: false }, forgeHosts: { "github.com": "github" } });
  expect(await h.runtime.provider(remote, getContext)).toBeUndefined();
  h.settings({ forges: { github: true }, forgeHosts: { "github.com": "missing" } });
  expect(await h.runtime.provider(remote, getContext)).toBeUndefined();
  expect(h.discover).not.toHaveBeenCalled();
  h.settings({ forges: { github: true }, forgeHosts: { "self.example": "github" } });
  expect(await h.runtime.provider("git@self.example:o/r", getContext)).toBeDefined();
  expect(h.discover).toHaveBeenCalledTimes(1);
});

it("binds registry revisions, exact bytes, settings and executable identity across cached reads and pending work", async () => {
  const h = harness();
  const changed = vi.fn();
  h.runtime.onInvalidate = changed;
  let valid = true;
  const manifest = parseForgeManifest(
    JSON.stringify({
      ...github,
      id: "copy",
      operations: { ...github.operations, batchStatus: undefined },
    }),
  );
  const plugin = {
    manifest,
    digest: "fixture-bytes",
    validate: vi.fn(() => {
      if (!valid) return Promise.reject(new Error("bytes changed"));
      return Promise.resolve();
    }),
  };
  h.runtime.replace([plugin]);
  h.runtime.replace([plugin]);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(() => {
    h.runtime.replace([plugin, plugin]);
  }).toThrow("Duplicate forge ID");
  h.settings({ forges: { copy: true }, forgeHosts: { "github.com": "copy" } });
  const provider = await h.runtime.provider(remote, getContext);
  expect(provider).not.toHaveProperty("batch");
  const row = {
    number: 42,
    headRefName: "feature",
    state: "OPEN",
    headRepositoryOwner: { login: "cli" },
    isCrossRepository: false,
  };
  vi.mocked(executeForge).mockImplementation((_exe, args) =>
    Promise.resolve({
      code: 0,
      stdout: args[0] === "auth" ? "" : JSON.stringify(row),
      stderr: "",
    }),
  );
  expect(await provider?.resolve?.(42)).toEqual({
    branch: "feature",
    state: "OPEN",
    sameRepository: true,
  });
  const count = vi.mocked(executeForge).mock.calls.length;
  await provider?.resolve?.(42);
  expect(executeForge).toHaveBeenCalledTimes(count);
  h.identity("executable-2");
  await provider?.resolve?.(42);
  expect(executeForge).toHaveBeenCalledTimes(count + 2);
  valid = false;
  expect(await provider?.resolve?.(42)).toBeUndefined();
  valid = true;
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(executeForge).mockImplementation(async () => {
    started?.();
    await gate;
    return { code: 0, stdout: JSON.stringify(row), stderr: "" };
  });
  const pending = provider?.resolve?.(43);
  await ready;
  h.settings({ forges: { copy: false }, forgeHosts: { "github.com": "copy" } });
  release?.();
  expect(await pending).toBeUndefined();
  expect(await provider?.resolve?.(42)).toBeUndefined();
  h.settings({ forges: { copy: true }, forgeHosts: { "github.com": "copy" } });
  const next = await h.runtime.provider(remote, getContext);
  h.path("/replacement/bin");
  expect(await h.runtime.provider(remote, getContext)).toBeDefined();
  expect(await next?.resolve?.(42)).toBeUndefined();
  h.runtime.replace([]);
  expect(await h.runtime.provider(remote, getContext)).toBeUndefined();
});

it("retires discovery that races registry replacement or shutdown", async () => {
  const h = harness();
  let release: (() => void) | undefined;
  h.discover.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return "/fixture/bin";
  });
  const pending = h.runtime.provider(remote, getContext);
  await vi.waitFor(() => {
    expect(release).toBeDefined();
  });
  h.runtime.invalidate();
  release?.();
  expect(await pending).toBeUndefined();
  await h.runtime.close();
  expect(await h.runtime.provider(remote, getContext)).toBeUndefined();
});

it.each(["legacy", "manifest"])("matches recorded tracking fixtures through %s", async (mode) => {
  const h = harness(0);
  const recorded = await capture("gh-view-public");
  const rollup = await capture("gh-rollup-public");
  const branch = forgeValue(recorded, ["headRefName"]);
  const number = forgeValue(recorded, ["number"]);
  const head = forgeValue(rollup, ["data", "node", "headRefOid"]);
  if (typeof branch !== "string" || typeof number !== "number" || typeof head !== "string")
    throw new Error("Invalid capture");
  let fork = true;
  let reads = 0;
  const transport = (args: readonly string[]): ForgeResponse => {
    if (args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
    reads++;
    // Construct only the batch envelope and target identity around captured evidence.
    const row = {
      number,
      headRefName: branch,
      headRefOid: head,
      state: "OPEN",
      title: "Recorded fixture",
      headRepository: { nameWithOwner: "cli/cli" },
      isCrossRepository: fork,
      commits: forgeValue(rollup, ["data", "node", "commits"]),
    };
    const query = args[5] ?? "";
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        data: {
          repository: {
            defaultBranchRef: { name: "trunk" },
            p0: query.includes("p0: pullRequest(number:")
              ? row
              : { nodes: [row], pageInfo: { hasNextPage: false } },
          },
        },
      }),
    };
  };
  vi.mocked(executeForge).mockImplementation((_exe, args) => Promise.resolve(transport(args)));
  const root = await mkdtemp(join(tmpdir(), "forge-runtime-"));
  roots.push(root);
  const directory = await privateDirectory(root);
  fork = true;
  reads = 0;
  let now = 100;
  const tree = {
    repository: join(root, "repo"),
    path: join(root, mode),
    identity: "owned",
    branch,
  };
  const tracker = new ForgeTracking(
    directory,
    () => Promise.resolve(remote),
    vi.fn(),
    mode === "manifest"
      ? h.runtime.provider
      : (url) => forgeProvider(url, (args) => Promise.resolve(transport(args).stdout)),
    () => now,
  );
  trackers.push(tracker);
  tracker.setEnabled(true);
  tracker.track(tree, number);
  h.runtime.onInvalidate = () => {
    tracker.invalidate();
  };
  await tracker.poll();
  expect(tracker.read(tree.repository, tree.path)).toBeUndefined();
  fork = false;
  h.runtime.invalidate();
  tracker.invalidate();
  await tracker.poll();
  now += 1000;
  await tracker.poll();
  expect(tracker.read(tree.repository, tree.path)).toEqual({
    number,
    headSha: head,
    state: "OPEN",
    requiredChecks: "none",
  });
  expect(tracker.readBoard(tree.repository, tree.path)).toEqual({
    number,
    title: "Recorded fixture",
    url: `https://github.com/cli/cli/pull/${String(number)}`,
    state: "OPEN",
    checks: { passed: 7, failed: 0, pending: 0 },
  });
  expect(reads).toBeGreaterThan(1);
});

it("fails closed when main cannot capture context or discover the login PATH", async () => {
  const h = harness();
  expect(
    await h.runtime.provider(remote, () => Promise.reject(new Error("removed"))),
  ).toBeUndefined();
  h.discover.mockRejectedValueOnce(new Error("shell unavailable"));
  expect(await h.runtime.provider(remote, getContext)).toBeUndefined();
});

it.each(["bytes", "executable", "registry", "worktree"] as const)(
  "discards a tracking batch changed during transport: %s",
  async (change) => {
    const h = harness();
    const root = await mkdtemp(join(tmpdir(), "forge-invalidation-"));
    roots.push(root);
    const tree = {
      repository: join(root, "repo"),
      path: join(root, "tree"),
      branch: "feature",
      identity: "owned",
    };
    let current: string | undefined = remote;
    let validBytes = true;
    const manifest = parseForgeManifest(JSON.stringify({ ...github, id: "copy" }));
    const plugin = {
      manifest,
      digest: "registered-bytes",
      validate: () => (validBytes ? Promise.resolve() : Promise.reject(new Error("changed"))),
    };
    h.runtime.replace([plugin]);
    h.settings({ forges: { copy: true }, forgeHosts: { "github.com": "copy" } });
    const tracker = new ForgeTracking(
      await privateDirectory(root),
      () => Promise.resolve(current),
      vi.fn(),
      h.runtime.provider,
    );
    trackers.push(tracker);
    h.runtime.onInvalidate = () => {
      tracker.invalidate();
    };
    tracker.track(tree, 42);
    const head = "a".repeat(40);
    vi.mocked(executeForge).mockImplementation((_exe, args) => {
      if (args[0] === "auth") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      if (change === "bytes") validBytes = false;
      if (change === "executable") h.identity("replaced");
      if (change === "registry") h.runtime.replace([]);
      if (change === "worktree") current = undefined;
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          data: {
            repository: {
              defaultBranchRef: { name: "main" },
              p0: {
                number: 42,
                title: "Fixture",
                headRefName: "feature",
                headRefOid: head,
                state: "OPEN",
                isCrossRepository: false,
                headRepository: { nameWithOwner: "cli/cli" },
                commits: { nodes: [{ commit: { oid: head, statusCheckRollup: null } }] },
              },
            },
          },
        }),
      });
    });
    await tracker.poll();
    expect(tracker.read(tree.repository, tree.path)).toBeUndefined();
  },
);

it.each(["invalidate", "close"])("handles %s while retiring a previous PATH", async (action) => {
  const h = harness();
  await h.runtime.provider(remote, getContext);
  let release: (() => void) | undefined;
  const closing = vi
    .spyOn(ForgeLifecycle.prototype, "close")
    .mockImplementationOnce(async function (this: ForgeLifecycle) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      closing.mockRestore();
      await this.close();
    });
  h.path("/replacement/bin");
  const pending = h.runtime.provider(remote, getContext);
  await vi.waitFor(() => {
    expect(release).toBeDefined();
  });
  const finished = vi.fn();
  const closed = action === "close" ? h.runtime.close().then(finished) : undefined;
  if (action === "invalidate") h.runtime.invalidate();
  await Promise.resolve();
  expect(finished).not.toHaveBeenCalled();
  release?.();
  await closed;
  expect(await pending).toBeUndefined();
  closing.mockRestore();
  if (action === "invalidate") expect(await h.runtime.provider(remote, getContext)).toBeDefined();
  else expect(finished).toHaveBeenCalledOnce();
});

it("uses selected enabled manifests for neutral auth preflight without sending project data", async () => {
  const h = harness(0);
  expect(await h.runtime.available()).toBe(true);
  expect(executeForge).toHaveBeenCalledTimes(1);
  expect(vi.mocked(executeForge).mock.calls[0]?.[1]).toEqual([
    "auth",
    "status",
    "--hostname",
    "github.com",
  ]);
  vi.mocked(executeForge).mockResolvedValue({ code: 1, stdout: "", stderr: "not logged in" });
  expect(await h.runtime.available()).toBe(false);
  h.settings({ forges: { github: false }, forgeHosts: { "github.com": "github" } });
  h.discover.mockClear();
  vi.mocked(executeForge).mockClear();
  expect(await h.runtime.available()).toBe(false);
  expect(h.discover).not.toHaveBeenCalled();
  expect(executeForge).not.toHaveBeenCalled();
});

it("cancels shutdown without notifying crashed or disposed board observers", async () => {
  const h = harness();
  const changed = vi.fn(() => {
    throw new Error("Disposed board");
  });
  h.runtime.onInvalidate = changed;
  await expect(h.runtime.close()).resolves.toBeUndefined();
  expect(changed).not.toHaveBeenCalled();
  expect(await h.runtime.provider(remote, getContext)).toBeUndefined();
});

it("reports host-only auth through the lifecycle without probing unassigned or disabled hosts", async () => {
  const h = harness();
  expect(await h.runtime.hostStatus("gitlab.com")).toBe("unassigned");
  expect(h.discover).not.toHaveBeenCalled();
  expect(await h.runtime.hostStatus("github.com")).toBe("ready");
  expect(vi.mocked(executeForge).mock.calls.map((call) => call[1])).toEqual([
    ["auth", "status", "--hostname", "github.com"],
  ]);
  vi.mocked(executeForge).mockResolvedValue({
    code: 1,
    stdout: "secret output",
    stderr: "not logged in",
  });
  expect(await h.runtime.hostStatus("github.com")).toBe("not-signed-in");
  vi.mocked(resolveForgeExecutable).mockRejectedValue(new Error("private path"));
  expect(await h.runtime.hostStatus("github.com")).toBe("not-installed");
  h.settings({ forges: { github: false }, forgeHosts: { "github.com": "github" } });
  expect(await h.runtime.hostStatus("github.com")).toBe("unassigned");
  await h.runtime.close();
  expect(await h.runtime.hostStatus("github.com")).toBe("unavailable");
});
it("does not publish readiness after settings change or failed PATH discovery", async () => {
  const h = harness();
  h.discover.mockRejectedValueOnce(new Error("private shell diagnostic"));
  expect(await h.runtime.hostStatus("github.com")).toBe("unavailable");
  vi.mocked(executeForge).mockImplementationOnce(() => {
    h.settings({ forges: { github: false }, forgeHosts: { "github.com": "github" } });
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  });
  expect(await h.runtime.hostStatus("github.com")).toBe("unavailable");
});

it("refuses readiness discovery when selected manifest bytes no longer validate", async () => {
  const h = harness();
  const manifest = parseForgeManifest(JSON.stringify({ ...github, id: "invalid-copy" }));
  const validate = vi.fn(() => Promise.reject(new Error("changed bytes")));
  h.runtime.replace([{ manifest, digest: "changed", validate }]);
  h.settings({ forges: { "invalid-copy": true }, forgeHosts: { "github.com": "invalid-copy" } });
  expect(await h.runtime.hostStatus("github.com")).toBe("unavailable");
  expect(h.discover).not.toHaveBeenCalled();
  expect(resolveForgeExecutable).not.toHaveBeenCalled();
});
