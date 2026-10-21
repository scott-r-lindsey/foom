import type * as Fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ForgeLifecycle } from "../../../../src/main/control/forge-lifecycle";
import { parseForgeManifest } from "../../../../src/shared/forge-manifest";
import github from "../../../../src/shared/bundled-forges/github.json";
import { githubManifest } from "../../../../src/main/control/forge-manifests";
import { executeForge, resolveForgeExecutable } from "../../../../src/main/control/forge-process";
import type { ForgeSelection } from "../../../../src/main/control/forge-lifecycle-types";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof Fs>();
  return { ...fs, rm: vi.fn(fs.rm) };
});

const roots: string[] = [];
const lifecycles: ForgeLifecycle[] = [];
afterEach(async () => {
  await Promise.all(lifecycles.splice(0).map((lifecycle) => lifecycle.close()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const posix = it.skipIf(process.platform === "win32");
async function fixture(timeoutMs = 3000, cacheMs = 20000, manifest = githubManifest) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foom-forge-test-")));
  roots.push(root);
  const bin = join(root, "bin with spaces");
  await mkdir(bin);
  const state = join(root, "state.json");
  const log = join(root, "calls.jsonl");
  const manifestFile = join(root, "manifest.json");
  const bytes = JSON.stringify(manifest);
  await writeFile(manifestFile, bytes);
  const executable = join(bin, "gh");
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.STATE, 'utf8'));
fs.appendFileSync(process.env.LOG, JSON.stringify({ args, cwd: process.cwd(), pager: process.env.GH_PAGER, capabilities: Object.keys(process.env).filter((key) => /^(FOOM_|ELECTRON_|CLAUDECODE$)/i.test(key)) }) + '\\n');
if (state.change && args[1] === 'view') fs.appendFileSync(process.env.MANIFEST, ' ');
if (state.displayFailure && args.at(-1)?.includes('title,url')) { process.stderr.write('HTTP 403 Forbidden'); process.exit(1); }
if ((state.hang && args[0] !== 'auth') || (state.displayHang && args.at(-1)?.includes('title,url'))) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'inherit'});
  fs.writeFileSync(process.env.PIDS, JSON.stringify([process.pid, child.pid]));
  setInterval(() => {}, 1000);
} else if (state.overflow) process.stdout.write('x'.repeat(300000));
else if (args[0] === 'auth') {
  if (state.auth) { process.stderr.write('secret-token ' + state.auth); process.exit(state.authCode ?? 1); }
} else if (state.forbidden) { process.stderr.write('HTTP 403 Forbidden secret-token'); process.exit(1); }
else if (state.malformed) process.stdout.write('{secret-token');
else if (args[1] === 'checks') process.stdout.write('[]');
else {
  const row = {number: 42, headRefOid: 'a'.repeat(40), headRefName: 'feature', state: 'MERGED', mergeCommit: {oid: 'b'.repeat(40)}, headRepositoryOwner: {login: 'owner'}, isCrossRepository: false};
  process.stdout.write(JSON.stringify(args[1] === 'list' ? [row] : row));
}
`,
    { mode: 0o700 },
  );
  const update = (value: unknown) => writeFile(state, JSON.stringify(value));
  await update({});
  const validate = vi.fn(async () => {
    if ((await readFile(manifestFile, "utf8")) !== bytes) throw new Error("Changed secret-token");
  });
  const plugin = {
    manifest,
    digest: createHash("sha256").update(bytes).digest("hex"),
    validate,
  };
  const lifecycle = new ForgeLifecycle({
    path: bin,
    timeoutMs,
    cacheMs,
    environment: {
      STATE: state,
      LOG: log,
      MANIFEST: manifestFile,
      PIDS: join(root, "pids"),
      FOOM_CONTROL_TOKEN: "must-not-leak",
      FOOM_CONFIG_TOKEN: "must-not-leak",
      ELECTRON_RUN_AS_NODE: "1",
      CLAUDECODE: "1",
    },
  });
  lifecycle.replace([plugin]);
  lifecycles.push(lifecycle);
  const context = { identity: "registered-worktree-generation-1", validate: vi.fn(async () => {}) };
  const selection: ForgeSelection = {
    plugin,
    remote: { host: "github.com", project: "owner/repo" },
    context,
    defaultBranch: "main",
  };
  const calls = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
  return { root, bin, executable, lifecycle, selection, update, calls, manifestFile };
}

posix(
  "resolves absolute native executables, skips unsafe PATH entries and validates names/files",
  async () => {
    const { bin, executable } = await fixture();
    expect(
      (await resolveForgeExecutable(["absent", "gh"], ["", ".", "relative", bin].join(delimiter)))
        .executable,
    ).toBe(executable);
    await expect(resolveForgeExecutable(["../gh"], bin)).rejects.toThrow("unavailable");
    await expect(resolveForgeExecutable(["gh"], ".")).rejects.toThrow("unavailable");
    await chmod(executable, 0o600);
    await expect(resolveForgeExecutable(["gh"], bin)).rejects.toThrow("unavailable");
    await mkdir(join(bin, "folder"));
    await expect(resolveForgeExecutable(["folder"], bin)).rejects.toThrow("unavailable");
  },
);

posix(
  "runs fixture argv in a disposable neutral cwd, narrows output and caches immutable samples",
  async () => {
    const { lifecycle, selection, calls, root } = await fixture();
    const p = lifecycle.provider(selection);
    const result = await p.lookup("feature", 42, "all");
    expect(result).toEqual({
      number: 42,
      headSha: "a".repeat(40),
      mergeCommit: "b".repeat(40),
      state: "MERGED",
      requiredChecks: "none",
      checksMeaning: "required",
    });
    const first = await calls();
    for (const call of first) expect(call).toHaveProperty("capabilities", []);
    expect(first).toHaveLength(5);
    expect(first[0]).toMatchObject({
      args: ["auth", "status", "--hostname", "github.com"],
      pager: "cat",
    });
    for (const call of first) {
      expect(call).toMatchObject({ cwd: expect.stringContaining("foom-forge-") as unknown });
      expect(call).not.toMatchObject({ cwd: root });
    }
    if (result) result.requiredChecks = "failure";
    expect(await p.lookup("feature", 42, "all")).toMatchObject({ requiredChecks: "none" });
    expect(await calls()).toHaveLength(5);
    expect(lifecycle.state()).toBe("ready");
    lifecycle.invalidate();
    await p.lookup("feature", 42, "all");
    expect(await calls()).toHaveLength(10);
    expect(await p.resolve?.(42)).toEqual({
      branch: "feature",
      state: "MERGED",
      sameRepository: true,
    });
    expect(await p.batch?.([{ branch: "feature" }])).toBeUndefined();
    await lifecycle.close();
    expect(await p.lookup("feature", 42)).toBeUndefined();
  },
);

posix(
  "rejects missing executable, unregistered, duplicate and revoked manifests without CLI reads",
  async () => {
    const { lifecycle, selection, bin, executable } = await fixture();
    expect(() => {
      lifecycle.replace([selection.plugin, selection.plugin]);
    }).toThrow("Duplicate");
    lifecycle.replace([]);
    expect(await lifecycle.provider(selection).lookup("feature")).toBeUndefined();
    lifecycle.replace([selection.plugin]);
    await rm(executable);
    expect(await lifecycle.provider(selection).lookup("feature")).toBeUndefined();
    expect(lifecycle.state()).toBe("unavailable");
    await expect(resolveForgeExecutable(["gh"], bin)).rejects.toThrow("unavailable");
  },
);

posix(
  "auth preflight and forbidden failures expose only a fixed state and never log secrets",
  async () => {
    const { lifecycle, selection, update, calls } = await fixture();
    const log = vi.spyOn(console, "error");
    for (const auth of ["not logged in", "authentication required"]) {
      for (const authCode of [0, 1]) {
        await update({ auth, authCode });
        expect(await lifecycle.provider(selection).lookup("feature")).toBeUndefined();
        expect(lifecycle.state()).toBe("unauthenticated");
      }
    }
    expect(await calls()).toHaveLength(4);
    await update({ forbidden: true });
    expect(await lifecycle.provider(selection).lookup("feature")).toBeUndefined();
    expect(lifecycle.state()).toBe("unauthenticated");
    expect(log).not.toHaveBeenCalled();
  },
);

posix("rejects malformed/oversized CLI output without publishing it", async () => {
  const { lifecycle, selection, update } = await fixture();
  for (const value of [{ malformed: true }, { overflow: true }]) {
    await update(value);
    expect(await lifecycle.provider(selection).lookup("feature")).toBeUndefined();
  }
  expect(lifecycle.state()).toBe("unavailable");
});

posix(
  "revalidates exact bytes before execution, cached reads, and publication after a mid-run edit",
  async () => {
    const { lifecycle, selection, update, manifestFile, calls } = await fixture();
    await update({ change: true });
    expect(await lifecycle.provider(selection).lookup("feature", 42, "all")).toBeUndefined();
    expect(lifecycle.state()).toBe("unavailable");
    expect(await calls()).toHaveLength(2);
    await writeFile(manifestFile, JSON.stringify(githubManifest));
    await update({});
    const p = lifecycle.provider(selection);
    expect(await p.lookup("feature", 42, "all")).toBeDefined();
    await writeFile(manifestFile, JSON.stringify(githubManifest) + " ");
    const count = (await calls()).length;
    expect(await p.lookup("feature", 42, "all")).toBeUndefined();
    expect(await calls()).toHaveLength(count);
  },
);

posix("revalidates worktree context and registry again after the last command", async () => {
  const { lifecycle, selection } = await fixture();
  let count = 0;
  selection.context.validate = () => {
    if (++count === 6) lifecycle.replace([]);
    return Promise.resolve();
  };
  expect(await lifecycle.provider(selection).lookup("feature", 42, "all")).toBeUndefined();
  expect(lifecycle.state()).toBe("cancelled");
});

async function waitPids(root: string): Promise<number[]> {
  const value = await vi.waitFor(
    async (): Promise<unknown> => JSON.parse(await readFile(join(root, "pids"), "utf8")),
  );
  if (!Array.isArray(value) || !value.every((pid): pid is number => typeof pid === "number"))
    throw new Error("Bad pids");
  return value;
}
async function assertDead(pids: number[]) {
  await vi.waitFor(() => {
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  });
}

posix("cancellation kills the fixture child process tree and returns no result", async () => {
  const { root, lifecycle, selection, update } = await fixture();
  await update({ hang: true });
  const controller = new AbortController();
  const pending = lifecycle
    .provider({ ...selection, signal: controller.signal })
    .lookup("feature", 42);
  const pids = await waitPids(root);
  controller.abort();
  expect(await pending).toBeUndefined();
  expect(lifecycle.state()).toBe("cancelled");
  await assertDead(pids);
  expect(
    await lifecycle.provider({ ...selection, signal: controller.signal }).lookup("feature"),
  ).toBeUndefined();
});

posix(
  "deadline kills the fixture process tree and invalidation/shutdown cancels pending reads",
  async () => {
    for (const stop of ["timeout", "invalidate", "close"]) {
      const { root, lifecycle, selection, update } = await fixture(stop === "timeout" ? 500 : 3000);
      await update({ hang: true });
      const pending = lifecycle.provider(selection).lookup("feature", 42);
      const pids = await waitPids(root);
      if (stop === "invalidate") lifecycle.invalidate();
      if (stop === "close") await lifecycle.close();
      expect(await pending).toBeUndefined();
      expect(lifecycle.state()).toBe(stop === "timeout" ? "timeout" : "cancelled");
      await assertDead(pids);
    }
  },
);

it("process execution rejects pre-aborted signals and missing binaries with fixed errors", async () => {
  await expect(executeForge("/absent", [], tmpdir(), {}, AbortSignal.abort())).rejects.toThrow(
    "cancelled",
  );
  await expect(
    executeForge("/absent", [], tmpdir(), {}, new AbortController().signal),
  ).rejects.toThrow("unavailable");
});

posix(
  "auth is cached per host, expires with time, and does not accept exit-zero negative markers",
  async () => {
    const manifest = parseForgeManifest(
      JSON.stringify({
        ...github,
        id: "test-forge",
        auth: { ...github.auth, failureContains: ["INVALID TOKEN"] },
      }),
      "config",
    );
    const { lifecycle, selection, update, calls } = await fixture(3000, 20, manifest);
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    await lifecycle.provider(selection).resolve?.(42);
    await lifecycle.provider(selection).lookup("feature", 42, "all");
    expect(
      (await calls()).filter(
        (call) =>
          typeof call === "object" &&
          call !== null &&
          "args" in call &&
          Array.isArray(call.args) &&
          call.args[0] === "auth",
      ),
    ).toHaveLength(1);
    await lifecycle
      .provider({ ...selection, remote: { ...selection.remote, host: "enterprise.example" } })
      .resolve?.(42);
    expect((await calls()).length).toBe(8);
    now.mockReturnValue(1021);
    await update({ auth: "invalid token", authCode: 0 });
    expect(await lifecycle.provider(selection).resolve?.(42)).toBeUndefined();
    expect(lifecycle.state()).toBe("unauthenticated");
  },
);

posix("rejects executable replacement and revoked worktree identity at publication", async () => {
  const { lifecycle, selection, executable } = await fixture();
  let count = 0;
  selection.context.validate = async () => {
    if (++count === 6) await writeFile(executable, (await readFile(executable, "utf8")) + "\n");
  };
  expect(await lifecycle.provider(selection).lookup("feature", 42, "all")).toBeUndefined();
  expect(lifecycle.state()).toBe("unavailable");
  selection.context.validate = () => Promise.reject(new Error("secret-token worktree removed"));
  expect(await lifecycle.provider(selection).resolve?.(42)).toBeUndefined();
  expect(lifecycle.state()).toBe("unavailable");
});

posix("finishes asynchronous cleanup before final byte/registry publication checks", async () => {
  const fs = await vi.importActual<typeof Fs>("node:fs/promises");
  for (const change of ["bytes", "registry"]) {
    const { lifecycle, selection, manifestFile } = await fixture();
    vi.mocked(rm).mockImplementationOnce(async (path, options) => {
      await fs.rm(path, options);
      if (change === "bytes") await writeFile(manifestFile, JSON.stringify(githubManifest) + " ");
      else lifecycle.replace([]);
    });
    expect(await lifecycle.provider(selection).lookup("feature", 42, "all")).toBeUndefined();
    expect(lifecycle.state()).toBe(change === "bytes" ? "unavailable" : "cancelled");
  }
});

posix("display transport failures and deadlines preserve verified checks", async () => {
  const { lifecycle, selection, update } = await fixture(1000, 0);
  for (const state of [{ displayFailure: true }, { displayHang: true }]) {
    await update(state);
    expect(await lifecycle.provider(selection).lookup("feature", 42, "all")).toMatchObject({
      number: 42,
      requiredChecks: "none",
      checksMeaning: "required",
    });
    expect(lifecycle.state()).toBe("ready");
  }
});
