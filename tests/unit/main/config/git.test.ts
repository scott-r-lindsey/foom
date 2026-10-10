import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { gitSync } from "../../../helpers/git.js";
import {
  ConfigGit,
  hardenedArguments,
  hardenedEnvironment,
  prepareIsolation,
} from "../../../../src/main/config/git";
import type { GitRunner } from "../../../../src/main/config/git";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "foom-config-git-"));
  roots.push(root);
  const folder = path.join(root, "config");
  await mkdir(folder);
  const isolation = await prepareIsolation(path.join(root, "isolation"));
  return { root, folder, isolation };
}

test("every call carries the hardening flags and an isolated environment", async () => {
  const { folder, isolation } = await fixture();
  const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const runner: GitRunner = (args, options) => {
    calls.push({ args, env: options.env });
    return Promise.resolve(Buffer.from(""));
  };
  const git = new ConfigGit(folder, isolation, runner, {
    PATH: "/bin",
    GIT_DIR: "/elsewhere",
    git_work_tree: "/elsewhere",
    GIT_CONFIG_COUNT: "1",
  });
  await git.init();
  await git.head();
  await git.tree("HEAD");
  await git.log(5);
  await git.changes("a".repeat(40));
  await git.blob("b".repeat(40));
  await git.commit(new Map([["settings.json", Buffer.from("{}")]]), "Change");
  await expect(git.blob("HEAD:../secret")).rejects.toThrow("Invalid object");
  expect(calls.length).toBeGreaterThan(6);
  const prefix = hardenedArguments(folder, isolation);
  for (const call of calls) {
    expect(call.args.slice(0, prefix.length)).toEqual(prefix);
    expect(call.env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: isolation.global,
      GIT_TERMINAL_PROMPT: "0",
      PATH: "/bin",
    });
    expect(call.env["GIT_DIR"]).toBeUndefined();
    expect(call.env["git_work_tree"]).toBeUndefined();
    expect(call.env["GIT_CONFIG_COUNT"]).toBeUndefined();
  }
  expect(prefix).toEqual(
    expect.arrayContaining([
      "--no-pager",
      `core.hooksPath=${isolation.hooks}`,
      "core.fsmonitor=false",
      "commit.gpgSign=false",
      "core.editor=:",
      "core.pager=cat",
    ]),
  );
  // Plumbing only: nothing that applies filters, merge drivers or hooks.
  const commands = new Set(calls.map((call) => call.args[prefix.length]));
  for (const forbidden of ["add", "commit", "revert", "merge", "checkout", "diff", "status"])
    expect(commands.has(forbidden)).toBe(false);
});

test("an inherited environment variable cannot redirect the global config", () => {
  const env = hardenedEnvironment(
    { HOME: "/home/me", GIT_CONFIG_GLOBAL: "/home/me/.gitconfig", Git_Exec_Path: "/evil" },
    { hooks: "/h", template: "/t", global: "/empty", index: "/i" },
  );
  expect(env["GIT_CONFIG_GLOBAL"]).toBe("/empty");
  expect(env["Git_Exec_Path"]).toBeUndefined();
  expect(env["HOME"]).toBe("/home/me");
});

test("isolation folders are recreated empty on every launch", async () => {
  const { root, isolation } = await fixture();
  await writeFile(path.join(isolation.hooks, "post-commit"), "#!/bin/sh\n");
  await writeFile(path.join(isolation.global), "[core]\n\thooksPath=/evil\n");
  const again = await prepareIsolation(path.join(root, "isolation"));
  expect(await readdir(again.hooks)).toEqual([]);
  expect(await readFile(again.global, "utf8")).toBe("");
  await rm(again.template, { recursive: true });
  await writeFile(again.template, "not a folder");
  const third = await prepareIsolation(path.join(root, "isolation"));
  expect((await stat(third.template)).isDirectory()).toBe(true);
});

test("plumbing commits, lists, diffs and reads blobs without filters", async () => {
  const { folder, isolation } = await fixture();
  const git = new ConfigGit(folder, isolation);
  expect(await git.exists()).toBe(false);
  await git.init();
  expect(await git.exists()).toBe(true);
  expect(await git.head()).toBeNull();
  const first = await git.commit(
    new Map([
      ["settings.json", Buffer.from('{"kind":"settings"}\n')],
      ["themes/a.json", Buffer.from("{}\n")],
    ]),
    "Initialize",
  );
  expect(await git.head()).toBe(first);
  const tree = await git.tree(first);
  expect([...tree.keys()].sort()).toEqual(["settings.json", "themes/a.json"]);
  expect(tree.get("settings.json")?.object).toBe(
    await git.objectId(Buffer.from('{"kind":"settings"}\n')),
  );
  const second = await git.commit(
    new Map<string, Uint8Array | null>([["themes/a.json", null]]),
    "Remove a",
  );
  const log = await git.log(5);
  expect(log.map((entry) => entry.subject)).toEqual(["Remove a", "Initialize"]);
  expect(log[0]).toMatchObject({ commit: second, files: ["themes/a.json"] });
  expect(log[1]?.files.sort()).toEqual(["settings.json", "themes/a.json"]);
  const changes = await git.changes(second);
  expect(changes).toEqual([
    { path: "themes/a.json", before: tree.get("themes/a.json")?.object, after: null },
  ]);
  const before = changes[0]?.before;
  if (!before) throw new Error("Expected the removed blob");
  expect((await git.blob(before)).toString()).toBe("{}\n");
  expect((await git.changes(first)).every((change) => change.before === null)).toBe(true);
});

test("a folder inside another repository is not a repository itself", async () => {
  const { folder, isolation } = await fixture();
  const parent = new ConfigGit(folder, isolation);
  await parent.init();
  const nested = path.join(folder, "nested");
  await mkdir(nested);
  const git = new ConfigGit(nested, isolation);
  expect(await git.exists()).toBe(false);
  expect(await git.head()).toBeNull();
});

test.skipIf(process.platform === "win32")(
  "planted hooks, fsmonitor, filters and signing programs never run",
  async () => {
    const { root, folder, isolation } = await fixture();
    const git = new ConfigGit(folder, isolation);
    await git.init();
    const marker = path.join(root, "ran");
    const script = path.join(root, "evil.sh");
    await writeFile(script, `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(marker)}\ncat\n`);
    await chmod(script, 0o755);
    const hooks = path.join(folder, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    for (const hook of [
      "post-commit",
      "pre-commit",
      "reference-transaction",
      "post-index-change",
    ]) {
      await writeFile(path.join(hooks, hook), `#!/bin/sh\n${script}\n`);
      await chmod(path.join(hooks, hook), 0o755);
    }
    await writeFile(
      path.join(folder, ".git", "config"),
      [
        "[core]",
        "\trepositoryformatversion = 0",
        `\thooksPath = ${hooks}`,
        `\tfsmonitor = ${script}`,
        `\tpager = ${script}`,
        "[commit]",
        "\tgpgSign = true",
        "[gpg]",
        `\tprogram = ${script}`,
        '[filter "evil"]',
        `\tclean = ${script}`,
        `\tsmudge = ${script}`,
        '[diff "evil"]',
        `\ttextconv = ${script}`,
        "",
      ].join("\n"),
    );
    await writeFile(path.join(folder, ".gitattributes"), "* filter=evil diff=evil\n");
    await mkdir(path.join(folder, ".git", "info"), { recursive: true });
    await writeFile(path.join(folder, ".git", "info", "attributes"), "* filter=evil diff=evil\n");
    const commit = await git.commit(
      new Map([["settings.json", Buffer.from('{"kind":"settings"}\n')]]),
      "Change",
    );
    await git.log(5);
    await git.changes(commit);
    const entry = (await git.tree(commit)).get("settings.json");
    if (!entry) throw new Error("Expected a committed file");
    expect((await git.blob(entry.object)).toString()).toBe('{"kind":"settings"}\n');
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  },
);

test("sha256 repositories, missing objects and a locked index", async () => {
  const { folder, isolation } = await fixture();
  gitSync(["init", "-q", "--object-format=sha256", folder]);
  const git = new ConfigGit(folder, isolation);
  const bytes = Buffer.from("{}\n");
  const commit = await git.commit(new Map([["a.json", bytes]]), "One");
  expect((await git.tree(commit)).get("a.json")?.object).toBe(await git.objectId(bytes));
  expect(await git.objectId(bytes)).toHaveLength(64);
  await expect(git.blob("0".repeat(64))).rejects.toThrow("Git command failed");
  // A busy real index does not block the commit itself.
  await writeFile(path.join(folder, ".git", "index.lock"), "");
  const second = await git.commit(new Map([["b.json", bytes]]), "Two");
  expect(await git.head()).toBe(second);
});
