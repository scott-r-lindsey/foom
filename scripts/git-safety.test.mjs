import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { gitSync, gitEnvironment } from "../tests/helpers/git.js";

const guard = resolve("scripts/pre-commit.mjs");
const setup = resolve("tests/helpers/setup.js");
const helper = resolve("tests/helpers/git.js");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "foom-git-safety-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, "parent");
  gitSync(["init", "-q", "-b", "main", parent]);
  gitSync(
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    ],
    { cwd: parent },
  );
  return { root, parent };
}
function shape(parent) {
  return ["config", "HEAD"].map((file) => readFileSync(join(parent, ".git", file), "utf8"));
}
test("helper and runner preload isolate git init from a hostile hook environment", (t) => {
  const { root, parent } = fixture(t);
  const before = shape(parent);
  const env = {
    ...process.env,
    GIT_DIR: join(parent, ".git"),
    GIT_WORK_TREE: parent,
    GIT_INDEX_FILE: join(parent, ".git/index"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_VALUE_0: "true",
  };
  for (const mode of ["helper", "preload"]) {
    const cwd = join(root, mode);
    mkdirSync(cwd);
    const code =
      mode === "helper"
        ? `require(${JSON.stringify(helper)}).gitSync(['init', '-q']);`
        : `require('node:child_process').execFileSync('git', ['init', '-q']);`;
    const child = spawnSync(
      process.execPath,
      [...(mode === "preload" ? ["--require", setup] : []), "-e", code],
      { cwd, env, encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(shape(parent), before);
    assert.equal(
      gitSync(["rev-parse", "--is-bare-repository"], { cwd }).toString().trim(),
      "false",
    );
  }
  const clean = gitEnvironment(env);
  assert.equal(clean.GIT_DIR, undefined);
  assert.equal(clean.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(clean.GIT_CONFIG_NOSYSTEM, "1");
});

for (const kind of ["ordinary", "linked", "bare-linked"]) {
  for (const action of ["pass", "fail", "bare", "worktree"]) {
    test(`pre-commit ${kind}: ${action}`, (t) => {
      const { root, parent } = fixture(t);
      let cwd = parent;
      let config = join(parent, ".git/config");
      if (kind !== "ordinary") {
        let repository = parent;
        if (kind === "bare-linked") {
          repository = join(root, "bare.git");
          gitSync(["clone", "--bare", "-q", parent, repository]);
          config = join(repository, "config");
        }
        cwd = join(root, "linked");
        gitSync(["worktree", "add", "-q", "-b", "linked", cwd], { cwd: repository });
      }
      const settings = () =>
        gitSync(["config", "--file", config, "--list"]).toString().split("\n").sort();
      const before = settings();
      const code =
        action === "bare" || action === "worktree"
          ? `require(${JSON.stringify(helper)}).gitSync(['config', '--file', ${JSON.stringify(config)}, 'core.${action}', ${JSON.stringify(action === "bare" ? (kind === "bare-linked" ? "false" : "true") : join(root, "missing"))}]); process.exit(7);`
          : `if (Object.keys(process.env).some(k => k.startsWith('GIT_'))) process.exit(9); process.exit(${action === "fail" ? 7 : 0});`;
      writeFileSync(join(cwd, "check.cjs"), code);
      writeFileSync(
        join(cwd, "package.json"),
        JSON.stringify({ scripts: { check: "node check.cjs" } }),
      );
      const gitDir = gitSync(["rev-parse", "--absolute-git-dir"], { cwd }).toString().trim();
      const result = spawnSync(process.execPath, [guard], {
        cwd,
        env: {
          ...process.env,
          GIT_DIR: gitDir,
          GIT_INDEX_FILE: join(gitDir, "index"),
          GIT_PREFIX: "",
        },
        encoding: "utf8",
      });
      assert.equal(
        result.status,
        action === "pass" ? 0 : action === "fail" ? 7 : 1,
        result.stdout + result.stderr,
      );
      if (action === "bare" || action === "worktree")
        assert.match(result.stderr, /a test wrote to the real repository/);
      assert.deepEqual(settings(), before);
    });
  }
}
