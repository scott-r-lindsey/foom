import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("local lint reuses only complete success and invalidates cross-file types, config and installed dependencies", (context) => {
  const root = mkdtempSync(join(tmpdir(), "foom-lint-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "src", "test-results", "node_modules/eslint/bin"])
    mkdirSync(join(root, dir), { recursive: true });
  for (const name of ["lint-local.mjs", "validation-fingerprint.mjs"])
    cpSync(new URL(name, import.meta.url), join(root, "scripts", name));
  writeFileSync(
    join(root, "node_modules/eslint/bin/eslint.js"),
    `
    const fs = require('node:fs');
    fs.appendFileSync('test-results/runs', 'run\\n');
    if (fs.readFileSync('src/type.ts', 'utf8') === 'fail') process.exitCode = 1;
  `,
  );
  writeFileSync(join(root, "src/type.ts"), "original");
  const run = () =>
    spawnSync(process.execPath, ["scripts/lint-local.mjs"], { cwd: root, encoding: "utf8" });
  const runs = () =>
    readFileSync(join(root, "test-results/runs"), "utf8").trim().split("\n").length;
  assert.equal(run().status, 0);
  assert.equal(run().status, 0);
  assert.equal(runs(), 1);
  for (const file of [
    "src/type.ts",
    "eslint.config.mjs",
    "tsconfig.json",
    "pnpm-lock.yaml",
    "node_modules/dependency.d.ts",
  ]) {
    const before = runs();
    writeFileSync(join(root, file), "changed");
    assert.equal(run().status, 0);
    assert.equal(runs(), before + 1, file);
    assert.equal(run().status, 0);
    assert.equal(runs(), before + 1, file);
  }
  rmSync(join(root, "src/type.ts"));
  assert.notEqual(run().status, 0);
  writeFileSync(join(root, "src/type.ts"), "fail");
  assert.notEqual(run().status, 0);
  const before = runs();
  assert.notEqual(run().status, 0);
  assert.equal(runs(), before + 1, "failures must never be cached");
});
