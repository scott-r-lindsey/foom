import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Electron shards register every test exactly once, preserve filtering and reject invalid shards", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "foom-shard-"));
  try {
    const fixture = path.join(directory, "partition.test.cjs");
    const helper = fileURLToPath(new URL("../tests/electron/test-shard.js", import.meta.url));
    const source = readFileSync(new URL("../tests/electron/app.test.js", import.meta.url), "utf8");
    const suiteNames = Array.from(source.matchAll(/^test\(\s*("(?:[^"\\]|\\.)*")/gm), (match) =>
      JSON.parse(match[1]),
    );
    assert.ok(suiteNames.length > 0);
    assert.equal(suiteNames.length, Array.from(source.matchAll(/^test\(/gm)).length);
    const names = [...suiteNames, ...Array.from({ length: 41 }, (_, index) => `case ${index}`)];
    writeFileSync(
      fixture,
      `const { test } = require(${JSON.stringify(helper)});\n` +
        names.map((name) => `test(${JSON.stringify(name)}, () => {});`).join("\n"),
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // The fixture needs its own runner and text reporter.
    const run = (shard, args = []) =>
      spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...args, fixture], {
        encoding: "utf8",
        env: { ...env, FOOM_ELECTRON_SHARD: shard },
      });
    for (const count of [2, 3]) {
      const registered = [];
      for (let index = 1; index <= count; index++) {
        const shard = `${index}/${count}`;
        const result = run(shard);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.doesNotMatch(result.stdout, /# SKIP/);
        registered.push(
          ...Array.from(result.stdout.matchAll(/^ok \d+ - (.+)$/gm), (match) => match[1]),
        );
      }
      assert.deepEqual(registered.sort(), [...names].sort());
    }
    const filtered = run("1/1", ["--test-name-pattern=^case 3$"]);
    assert.equal(filtered.status, 0, filtered.stdout + filtered.stderr);
    assert.match(filtered.stdout, /^ok \d+ - case 3$/m);
    for (const shard of ["", "0/2", "3/2", "1/0", "1/17", "all"]) {
      const result = run(shard);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /FOOM_ELECTRON_SHARD/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
