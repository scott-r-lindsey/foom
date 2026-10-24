import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitSync } from "../tests/helpers/git.js";
import { changedPaths, runAffected, selectAffected } from "./electron-affected.mjs";

test("affected selection unions mapped areas deterministically", () => {
  const paths = [
    "src/renderer/terminal/middle-click.ts",
    "src/renderer/preview/markdown.css",
    "src/renderer/sound/recording.ts",
  ];
  const expected = {
    full: false,
    reason: "All changed paths have explicit mappings",
    suites: [
      "preflight.test.js",
      "previews-agent.test.js",
      "previews-composition.test.js",
      "previews-files.test.js",
      "previews-focus.test.js",
      "previews-move.test.js",
      "previews-reload.test.js",
      "previews-security.test.js",
      "settings-accessibility.test.js",
      "settings-agents.test.js",
      "settings-appearance.test.js",
      "settings-general.test.js",
      "settings-sound.test.js",
      "terminal.test.js",
      "webgl.test.js",
      "workspace-cleanup.test.js",
      "workspace-commands.test.js",
      "workspace-repositories.test.js",
      "workspace-sidebar.test.js",
      "workspace-tiles.test.js",
      "workspace-windows.test.js",
    ],
  };
  assert.deepEqual(selectAffected(["src/renderer/preview/markdown.ts"]).suites, [
    "previews-agent.test.js",
    "previews-composition.test.js",
    "previews-files.test.js",
    "previews-focus.test.js",
    "previews-move.test.js",
    "previews-reload.test.js",
    "previews-security.test.js",
  ]);
  assert.deepEqual(selectAffected(["src/renderer/sound/volume-control.tsx"]).suites, [
    "preflight.test.js",
    "settings-accessibility.test.js",
    "settings-agents.test.js",
    "settings-appearance.test.js",
    "settings-general.test.js",
    "settings-sound.test.js",
  ]);
  assert.deepEqual(selectAffected(["src/renderer/sound/sound-controls.tsx"]).suites, [
    "preflight.test.js",
    "settings-accessibility.test.js",
    "settings-agents.test.js",
    "settings-appearance.test.js",
    "settings-general.test.js",
    "settings-sound.test.js",
  ]);
  assert.deepEqual(selectAffected(paths), expected);
  assert.deepEqual(selectAffected([...paths].reverse().concat(paths)), expected);
});

test("unknown paths and every shared boundary fall back to full, even beside mapped paths", () => {
  for (const path of [
    "new-area.ts",
    "src/renderer/sound/sound-controller.ts",
    "src/renderer/sound/web-audio.ts",
    "src/main/main.ts",
    "src/main/terminals/terminal-ipc.ts",
    "src/preload/preload.ts",
    "src/shared/terminal-host-protocol.ts",
    "src/renderer/index.html",
    "src/renderer/styles/styles.css",
    "tests/electron/harness.js",
    "tests/electron/process-audit.js",
    "tests/electron/test-shard.js",
    "tests/electron/shard-plan.json",
    "scripts/electron-tests.mjs",
    "forge.config.cjs",
    "package.json",
    "pnpm-lock.yaml",
    "AGENTS.md",
    "src/renderer/preview-other/file.ts",
  ]) {
    assert.equal(selectAffected(["src/renderer/preview/markdown.ts", path]).full, true, path);
  }
  assert.equal(selectAffected([]).full, true);
});

test("Git comparison includes branch, staged, unstaged, untracked, deleted and both renamed paths", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "foom-affected-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (args) => gitSync(args, { cwd, encoding: "utf8" });
  const commit = () =>
    git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"]);
  git(["init", "-q", "-b", "main"]);
  for (const name of ["committed", "staged", "unstaged", "deleted", "rename-old"])
    writeFileSync(join(cwd, name), name);
  git(["add", "."]);
  commit();
  git(["branch", "base"]);
  writeFileSync(join(cwd, "committed"), "branch edit");
  git(["add", "."]);
  commit();
  writeFileSync(join(cwd, "staged"), "index edit");
  renameSync(join(cwd, "rename-old"), join(cwd, "rename-new"));
  git(["add", "."]);
  writeFileSync(join(cwd, "unstaged"), "working edit");
  writeFileSync(join(cwd, "untracked\nfile"), "new");
  rmSync(join(cwd, "deleted"));
  assert.deepEqual(changedPaths("base", git), [
    "committed",
    "deleted",
    "rename-new",
    "rename-old",
    "staged",
    "unstaged",
    "untracked\nfile",
  ]);
  // A working-tree reversal must not hide committed or staged paths.
  writeFileSync(join(cwd, "committed"), "committed");
  writeFileSync(join(cwd, "staged"), "staged");
  const reversed = changedPaths("base", git);
  assert.ok(reversed.includes("committed"));
  assert.ok(reversed.includes("staged"));
  assert.throws(() => changedPaths("--invalid", git));
});

test("affected runner wraps Linux in Xvfb, forwards suites and propagates failures", () => {
  const calls = [];
  const options = {
    env: {},
    paths: (base) => {
      assert.equal(base, "origin/main");
      return ["src/renderer/preview/markdown.ts"];
    },
    run: (...args) => {
      calls.push(args);
      return { status: 7 };
    },
  };
  assert.equal(runAffected({ ...options, platform: "linux" }), 7);
  assert.deepEqual(calls[0], [
    "xvfb-run",
    [
      "-a",
      process.execPath,
      "scripts/electron-tests.mjs",
      "--suite=previews-agent.test.js",
      "--suite=previews-composition.test.js",
      "--suite=previews-files.test.js",
      "--suite=previews-focus.test.js",
      "--suite=previews-move.test.js",
      "--suite=previews-reload.test.js",
      "--suite=previews-security.test.js",
    ],
    { stdio: "inherit" },
  ]);
  assert.equal(runAffected({ ...options, platform: "win32" }), 7);
  assert.deepEqual(calls[1], [
    process.execPath,
    [
      "scripts/electron-tests.mjs",
      "--suite=previews-agent.test.js",
      "--suite=previews-composition.test.js",
      "--suite=previews-files.test.js",
      "--suite=previews-focus.test.js",
      "--suite=previews-move.test.js",
      "--suite=previews-reload.test.js",
      "--suite=previews-security.test.js",
    ],
    { stdio: "inherit" },
  ]);
});

test("comparison failure, empty changes, missing suite and unknown paths run the full suite", () => {
  for (const options of [
    {
      paths: () => {
        throw Error("missing base");
      },
    },
    { paths: () => [] },
    { paths: () => ["unknown"] },
    { paths: () => ["src/renderer/preview/markdown.ts"], inventory: [] },
  ]) {
    let called = false;
    assert.equal(
      runAffected({
        ...options,
        env: {},
        platform: "linux",
        run: (command, args) => {
          called = true;
          assert.equal(command, "xvfb-run");
          assert.deepEqual(args, ["-a", process.execPath, "scripts/electron-tests.mjs"]);
          return { status: 0 };
        },
      }),
      0,
    );
    assert.equal(called, true);
  }
  assert.throws(() => runAffected({ env: { FOOM_ELECTRON_SHARD: "1/4" } }), /unset/);
  assert.throws(
    () => runAffected({ env: {}, paths: () => [], run: () => ({ error: Error("spawn failed") }) }),
    /spawn failed/,
  );
  assert.equal(runAffected({ env: {}, paths: () => [], run: () => ({ status: null }) }), 1);
});
