import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { hooks } = require("../forge.config.js");

test("package and make delegate their single application build to Forge", () => {
  for (const command of ["package", "make"]) {
    assert.equal(manifest.scripts[command], `electron-forge ${command}`);
    for (const prefix of ["pre", "post"]) {
      assert.equal(manifest.scripts[`${prefix}${command}`], undefined);
    }
  }
});

test("every Forge packaging invocation runs one fresh build without sample arguments", (t) => {
  const build = t.mock.method(childProcess, "execFileSync", () => {});
  for (let invocation = 1; invocation <= 2; invocation++) {
    hooks.prePackage();
    assert.equal(build.mock.callCount(), invocation);
    const [executable, args, options] = build.mock.calls[invocation - 1].arguments;
    assert.equal(executable, process.execPath);
    assert.deepEqual(args, [join(root, "scripts/build.mjs")]);
    assert.deepEqual(options, { cwd: root, stdio: "inherit" });
  }
});

test("a failed production build stops packaging instead of reusing stale output", (t) => {
  const failure = new Error("production build failed");
  t.mock.method(childProcess, "execFileSync", () => {
    throw failure;
  });
  assert.throws(
    () => hooks.prePackage(),
    (error) => error === failure,
  );
});

test("the directly used Squirrel toolchain loads offline with its required dependencies", () => {
  const installer = require("electron-winstaller");
  assert.equal(typeof installer.createWindowsInstaller, "function");
  assert.equal(manifest.devDependencies["electron-winstaller"], "5.4.4");
});

test("packaged macOS bundles prevent Squirrel downgrades", () => {
  assert.equal(
    require("../forge.config.js").packagerConfig.extendInfo.ElectronSquirrelPreventDowngrades,
    true,
  );
});
