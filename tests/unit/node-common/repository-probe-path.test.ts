import type * as FS from "node:fs/promises";
import {
  mkdtemp,
  mkdir,
  lstat,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repositoryProbePath } from "../../../src/node-common/repository-probe-path";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const recorded = vi.hoisted(() => ({ created: "" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FS>();
  return {
    ...fs,
    realpath: vi.fn(fs.realpath),
    stat: vi.fn(fs.stat),
    lstat: vi.fn(fs.lstat),
    symlink: vi.fn(fs.symlink),
    mkdtemp: vi.fn(async (prefix: Parameters<typeof fs.mkdtemp>[0]) => {
      const path = await fs.mkdtemp(prefix);
      recorded.created = path;
      return path;
    }),
  };
});
let root: string;
const scopes: Awaited<ReturnType<typeof repositoryProbePath>>[] = [];
beforeEach(async () => {
  const actual = await vi.importActual<typeof FS>("node:fs/promises");
  vi.mocked(realpath).mockImplementation(actual.realpath);
  vi.mocked(stat).mockImplementation(actual.stat);
  vi.mocked(lstat).mockImplementation(actual.lstat);
  vi.mocked(symlink).mockImplementation(actual.symlink);
  root = await realpath(await mkdtemp(join(tmpdir(), "probe-path-test-")));
  recorded.created = "";
});
afterEach(async () => {
  await Promise.all(scopes.splice(0).map((scope) => scope.dispose()));
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
const create = async (path: string, excluded: readonly string[] = []) => {
  const scope = await repositoryProbePath({ PATH: path }, excluded);
  scopes.push(scope);
  return scope;
};
describe.skipIf(process.platform === "win32")("private probe PATH", () => {
  it("pins verified canonical tools, excludes user bins, shadows missing interpreters and disposes", async () => {
    const bins = join(root, "bin");
    const safe = join(root, "safe");
    const repo = join(root, "repo");
    await Promise.all([mkdir(bins), mkdir(safe), mkdir(repo)]);
    await writeFile(join(safe, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await symlink(join(safe, "node"), join(bins, "node"));
    await mkdir(join(bins, "pnpm")); // A searchable directory is not an executable tool.
    const scope = await create(["relative", bins].join(delimiter), [repo]);
    const pinned = scope.path.split(delimiter)[0];
    if (!pinned) throw new Error("No pin directory");
    const info = await lstat(pinned);
    expect(info.mode & 0o777).toBe(0o700);
    expect(info.uid).toBe(process.getuid?.());
    expect(scope.resolve("node")).toBe(join(safe, "node"));
    expect(scope.invocation(join(safe, "node"), ["--version"])).toEqual({
      command: await realpath("/bin/sh"),
      args: [join(safe, "node"), "--version"],
    });
    expect(await readFile(join(pinned, "node"), "utf8")).toContain(join(safe, "node"));
    expect(scope.resolve("pnpm")).toBeUndefined();
    expect(await readFile(join(pinned, "pnpm"), "utf8")).toContain("exit 127");
    expect(scope.path.split(delimiter)).not.toContain(bins);
    for (const path of scope.path.split(delimiter).slice(1)) {
      const system = await stat(path);
      expect(system.uid).toBe(0);
      expect(system.mode & 0o022).toBe(0);
    }
    await scope.dispose();
    expect(scope.resolve("node")).toBeUndefined();
    expect(scope.assertOpen).toThrow("closed");
    expect(() => scope.invocation("/fixture", [])).toThrow("closed");
    await expect(lstat(pinned)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("cannot fall through to a system node when the verified interpreter is absent", async () => {
    const scope = await create("");
    const pinned = scope.path.split(delimiter)[0];
    if (!pinned) throw new Error("No pins");
    await expect(
      promisify(execFile)(join(pinned, "node"), ["--version"], { env: { PATH: scope.path } }),
    ).rejects.toMatchObject({ code: 127 });
  });
  it("omits a login tool already resolving inside the repository", async () => {
    const repo = join(root, "repo"),
      bins = join(root, "bin");
    await Promise.all([mkdir(repo), mkdir(bins)]);
    await writeFile(join(repo, "node"), "fixture", { mode: 0o700 });
    await symlink(join(repo, "node"), join(bins, "node"));
    expect((await create(bins, [repo])).resolve("node")).toBeUndefined();
  });
  it.each(["writable", "owner", "file", "symlink"])(
    "refuses unsafe private directory metadata: %s",
    async (kind) => {
      const actual = await vi.importActual<typeof FS>("node:fs/promises");
      vi.mocked(lstat).mockImplementationOnce(async (path) => {
        const info = await actual.lstat(path);
        if (kind === "writable") info.mode |= 0o022;
        if (kind === "owner") info.uid += 1;
        if (kind === "file") Object.defineProperty(info, "isDirectory", { value: () => false });
        if (kind === "symlink")
          Object.defineProperty(info, "isSymbolicLink", { value: () => true });
        return info;
      });
      await expect(create("")).rejects.toThrow("Unsafe probe directory");
      await expect(actual.lstat(recorded.created)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("cleans partial pin construction on failure", async () => {
    const bins = join(root, "bin");
    await mkdir(bins);
    await writeFile(join(bins, "node"), "fixture", { mode: 0o700 });
    vi.mocked(symlink).mockRejectedValueOnce(new Error("No link"));
    await expect(create(bins)).rejects.toThrow("No link");
    await expect(lstat(recorded.created)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["writable", "owner", "file", "excluded"])(
    "refuses an unsafe fixed interpreter/system scope: %s",
    async (kind) => {
      const actual = await vi.importActual<typeof FS>("node:fs/promises");
      vi.mocked(stat).mockImplementation(async (path) => {
        const info = await actual.stat(path);
        if (kind === "writable") info.mode |= 0o022;
        if (kind === "owner") info.uid += 1;
        if (kind === "file") {
          Object.defineProperty(info, "isDirectory", { value: () => false });
          Object.defineProperty(info, "isFile", { value: () => false });
        }
        return info;
      });
      const excluded = kind === "excluded" ? [await actual.realpath("/bin/sh")] : [];
      await expect(create("", excluded)).rejects.toThrow("Unsafe probe interpreter");
      expect(recorded.created).toBe("");
    },
  );
  it("omits system directories inside the excluded code root", async () => {
    const excluded = await realpath("/usr/sbin");
    expect((await create("", [excluded])).path.split(delimiter)).not.toContain(excluded);
  });
  it("pins a Homebrew executable only through its permitted installation directory", async () => {
    const file = join(root, "brew");
    await writeFile(file, "fixture", { mode: 0o700 });
    const actual = await vi.importActual<typeof FS>("node:fs/promises");
    vi.mocked(realpath).mockImplementation((path, options) => {
      if (typeof path === "string" && path.startsWith("/usr/local/bin/"))
        return path.endsWith("/brew")
          ? Promise.resolve(file)
          : Promise.reject(new Error("No fixture tool"));
      return actual.realpath(path, options);
    });
    expect((await create("/usr/local/bin")).resolve("brew")).toBe(file);
  });
  it("rejects a pin directory placed inside an excluded tree", async () => {
    await expect(create("", [await realpath(tmpdir())])).rejects.toThrow("Unsafe probe directory");
    await expect(lstat(recorded.created)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("cleans a directory when canonicalization fails after creation", async () => {
    const actual = await vi.importActual<typeof FS>("node:fs/promises");
    vi.mocked(realpath).mockImplementation((path, options) =>
      typeof path === "string" && path.includes("foom-setup-probes-")
        ? Promise.reject(new Error("Lost directory"))
        : actual.realpath(path, options),
    );
    await expect(create("")).rejects.toThrow("Lost directory");
    await expect(lstat(recorded.created)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([
    "absolute",
    "symlink",
    "relative",
    "nested",
    "cycle",
    "deep",
    "env-options",
    "env-flag",
    "worktree",
    "env-missing",
    "oversized",
    "malformed",
  ])("blocks unsafe static interpreter chains: %s", async (kind) => {
    const repo = join(root, "repo"),
      bins = join(root, "bins");
    await Promise.all([mkdir(repo), mkdir(bins)]);
    const bad = join(repo, "node");
    const marker = join(root, "bad-called");
    await writeFile(bad, `#!/bin/sh\nprintf bad > ${quote(marker)}\n`, { mode: 0o700 });
    const alias = join(root, "node-alias");
    await symlink(bad, alias);
    const node = join(bins, "node");
    let header = `#!${bad}\n`;
    if (kind === "symlink") header = `#!${alias}\n`;
    if (kind === "relative") header = "#!relative-node\n";
    if (kind === "env-options") header = "#!/usr/bin/env -S node\n";
    if (kind === "env-flag") header = "#!/usr/bin/env -S\n";
    if (kind === "worktree") header = `#!${bad}\n`;
    if (kind === "env-missing") header = "#!/usr/bin/env missing-fixture-interpreter\n";
    if (kind === "oversized") header = "#!" + "x".repeat(4096);
    if (kind === "malformed") header = "#!\n";
    if (kind === "cycle") header = `#!${node}\n`;
    if (kind === "nested" || kind === "deep") {
      let parent = kind === "nested" ? bad : await realpath("/bin/sh");
      for (let n = 0; n < (kind === "deep" ? 5 : 1); n++) {
        const file = join(root, `interpreter-${String(n)}`);
        await writeFile(file, `#!${parent}\n`, { mode: 0o700 });
        parent = file;
      }
      header = `#!${parent}\n`;
    }
    await writeFile(node, header, { mode: 0o700 });
    const scope = await create(
      bins,
      kind === "worktree" ? [join(root, "registered"), repo] : [repo],
    );
    expect(() => scope.invocation(node, ["--version"])).toThrow("Unsafe probe interpreter chain");
    const pinned = scope.path.split(delimiter)[0];
    if (!pinned) throw new Error("No pins");
    await expect(
      promisify(execFile)(join(pinned, "node"), ["--version"], { env: { PATH: scope.path } }),
    ).rejects.toMatchObject({ code: 127 });
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("flattens argument-free nested canonical interpreters, including env NAME", async () => {
    const bins = join(root, "bins'quote");
    await mkdir(bins);
    const interpreter = join(root, "interpreter'quote");
    await writeFile(interpreter, "#!/bin/sh\nprintf '10.34.7\\n'\n", { mode: 0o700 });
    const node = join(bins, "node"),
      pnpm = join(bins, "pnpm");
    await writeFile(node, `#!${interpreter}\n`, { mode: 0o700 });
    await writeFile(pnpm, "#!/usr/bin/env node\n", { mode: 0o700 });
    const scope = await create(bins);
    const invocation = scope.invocation(pnpm, ["--version"]);
    expect(invocation).toEqual({
      command: await realpath("/bin/sh"),
      args: [interpreter, node, pnpm, "--version"],
    });
    expect(
      (
        await promisify(execFile)(invocation.command, [...invocation.args], {
          env: { PATH: scope.path },
        })
      ).stdout,
    ).toBe("10.34.7\n");
    const pinned = scope.path.split(delimiter)[0];
    if (!pinned) throw new Error("No pins");
    expect(
      (
        await promisify(execFile)(join(pinned, "pnpm"), ["--version"], {
          env: { PATH: scope.path },
        })
      ).stdout,
    ).toBe("10.34.7\n");
  });
  it.each([false, true])(
    "resolves env system interpreters, including a canonical alias: %s",
    async (alias) => {
      const bins = join(root, "bins");
      await mkdir(bins);
      const node = join(bins, "node");
      const env = alias ? join(root, "env-alias") : "/usr/bin/env";
      if (alias) await symlink(await realpath("/usr/bin/env"), env);
      await writeFile(node, `#!${env} sh\nprintf 'v24.17.0\\n'\n`, { mode: 0o700 });
      const scope = await create(bins);
      expect(scope.invocation(node, ["--version"])).toEqual({
        command: await realpath("/bin/sh"),
        args: [node, "--version"],
      });
    },
  );
  it.each([3, 4])("enforces the four-script limit at its boundary: %s parents", async (parents) => {
    const bins = join(root, "bins");
    await mkdir(bins);
    let parent = await realpath("/bin/sh");
    for (let n = 0; n < parents; n++) {
      const file = join(root, `parent-${String(n)}`);
      await writeFile(file, `#!${parent}\n`, { mode: 0o700 });
      parent = file;
    }
    const node = join(bins, "node");
    await writeFile(node, `#!${parent}\n`, { mode: 0o700 });
    const scope = await create(bins);
    if (parents === 3) expect(scope.invocation(node, []).args).toHaveLength(4);
    else expect(() => scope.invocation(node, [])).toThrow("Unsafe probe interpreter chain");
  });
  it.each(
    ["R", "W"].flatMap((scope) =>
      [false, true].flatMap((alias) =>
        ["preload", "script"].map((kind) => ({ scope, alias, kind })),
      ),
    ),
  )(
    "blocks interpreter payload operands: $scope alias=$alias $kind",
    async ({ scope: selected, alias, kind }) => {
      const repository = join(root, "R"),
        worktree = join(root, "W"),
        bins = join(root, "bin");
      await Promise.all([mkdir(repository), mkdir(worktree), mkdir(bins)]);
      const target = selected === "R" ? repository : worktree;
      const marker = join(root, "payload-executed");
      const payload = join(target, kind === "preload" ? "payload.cjs" : "payload.sh");
      await writeFile(
        payload,
        kind === "preload"
          ? `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');\n`
          : `printf bad > ${quote(marker)}\n`,
      );
      const operand = alias ? join(root, "payload-alias") : payload;
      if (alias) await symlink(payload, operand);
      const tool = join(bins, "pnpm");
      const interpreter =
        kind === "preload" ? await realpath(process.execPath) : await realpath("/bin/sh");
      await writeFile(
        tool,
        `#!${interpreter} ${kind === "preload" ? "--require=" : ""}${operand}\n`,
        { mode: 0o700 },
      );
      const scope = await create(bins, [repository, worktree]);
      expect(() => scope.invocation(tool, ["--version"])).toThrow("Unsafe probe interpreter chain");
      const pinned = scope.path.split(delimiter)[0];
      if (!pinned) throw new Error("No pins");
      await expect(
        promisify(execFile)(join(pinned, "pnpm"), ["--version"], { env: { PATH: scope.path } }),
      ).rejects.toMatchObject({ code: 127 });
      await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it.each(
    ["-e", "-c", "--version", "--require=external.cjs", "external-script", "--"].flatMap(
      (argument) => [false, true].map((nested) => ({ argument, nested })),
    ),
  )("refuses every non-env argument: $argument nested=$nested", async ({ argument, nested }) => {
    const bins = join(root, "bin");
    await mkdir(bins);
    const tool = join(bins, "pnpm");
    const interpreter = join(root, "interpreter");
    await writeFile(interpreter, `#!/bin/sh ${argument}\n`, { mode: 0o700 });
    await writeFile(tool, nested ? `#!${interpreter}\n` : `#!/bin/sh ${argument}\n`, {
      mode: 0o700,
    });
    const scope = await create(bins);
    expect(() => scope.invocation(tool, ["--version"])).toThrow("Unsafe probe interpreter chain");
  });
});
