import { selectAffected } from "./electron-affected.mjs";
import { suiteFiles } from "../tests/electron/test-suites.js";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Electron shards register every test exactly once, preserve filtering and reject invalid shards", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "foom-shard-#-"));
  try {
    const helper = fileURLToPath(new URL("../tests/electron/test-shard.js", import.meta.url));
    // Collect actual registrations in every discovered suite, including generated
    // cases, without invoking a test body or launching Electron/agent fixtures.
    const suites = suiteFiles().map((file) => {
      const names = [];
      const suiteRequire = createRequire(file);
      runInNewContext(readFileSync(file, "utf8"), {
        process,
        require: (specifier) =>
          specifier === "./test-shard.js"
            ? { test: (name) => names.push(name) }
            : suiteRequire(specifier),
      });
      assert.ok(names.length > 0, `No registrations in ${file}`);
      return names;
    });
    const suiteNames = suites.flat();
    assert.ok(suiteNames.length > 0);
    assert.equal(new Set(suiteNames).size, suiteNames.length);
    const plan = JSON.parse(
      readFileSync(new URL("../tests/electron/shard-plan.json", import.meta.url), "utf8"),
    );
    const discoveredFiles = suiteFiles().map((file) => path.basename(file));
    const previewSuites = selectAffected(["src/renderer/preview/markdown.ts"]).suites;
    const terminalSuites = selectAffected(["src/renderer/terminal/shell-controller.ts"]).suites;
    for (const [original, replacements] of Object.entries(plan.suiteSplits)) {
      assert.ok(!discoveredFiles.includes(original), `Retired suite: ${original}`);
      assert.equal(new Set(replacements).size, replacements.length);
      for (const replacement of replacements) {
        assert.ok(discoveredFiles.includes(replacement), `Missing suite: ${replacement}`);
        if (original === "previews.test.js")
          assert.ok(
            previewSuites.includes(replacement),
            `Missing preview coverage: ${replacement}`,
          );
        assert.ok(
          terminalSuites.includes(replacement),
          `Missing terminal coverage: ${replacement}`,
        );
      }
    }
    const plannedNames = plan.shards.flatMap(Object.keys);
    assert.equal(new Set(plannedNames).size, plannedNames.length, "duplicate planned test");
    assert.ok(
      plannedNames.every((name) => suiteNames.includes(name)),
      "remove stale plan names",
    );
    for (const shard of plan.shards) {
      for (const durations of Object.values(shard)) {
        assert.equal(durations.length, plan.platforms.length);
        assert.ok(durations.every((seconds) => Number.isFinite(seconds) && seconds >= 0));
      }
    }
    const names = [...suiteNames, ...Array.from({ length: 41 }, (_, index) => `case ${index}`)];
    const fixtures = [...suites, names.slice(suiteNames.length)].map((cases, index) => {
      const file = path.join(directory, `${index}.test.cjs`);
      writeFileSync(
        file,
        `const { test } = require(${JSON.stringify(helper)});\n` +
          cases.map((name) => `test(${JSON.stringify(name)}, () => {});`).join("\n"),
      );
      return file;
    });
    // TAP escapes Windows separators and # in empty-file placeholder names.
    const filePlaceholders = new Set(
      fixtures.map((file) => file.replaceAll("\\", "\\\\").replaceAll("#", "\\#")),
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // The fixture needs its own runner and text reporter.
    const run = (shard, args = []) =>
      spawnSync(
        process.execPath,
        ["--test", "--test-concurrency=1", "--test-reporter=tap", ...args, ...fixtures],
        {
          encoding: "utf8",
          env: { ...env, FOOM_ELECTRON_SHARD: shard },
        },
      );
    for (const count of [1, 2, 3, 4, 16]) {
      const registered = [];
      for (let index = 1; index <= count; index++) {
        const shard = `${index}/${count}`;
        const result = run(shard);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.doesNotMatch(result.stdout, /# SKIP/);
        const selected = Array.from(
          result.stdout.matchAll(/^ok \d+ - (.+)$/gm),
          (match) => match[1],
        ).filter((name) => !filePlaceholders.has(name)); // Node reports empty files as passing placeholders.
        const expected = names.filter((name) => {
          const planned =
            count === plan.shards.length
              ? plan.shards.findIndex((tests) => Object.hasOwn(tests, name))
              : -1;
          const bucket =
            planned >= 0
              ? planned
              : createHash("sha256").update(name).digest().readUInt32BE(0) % count;
          return bucket === index - 1;
        });
        assert.deepEqual(selected.sort(), expected.sort(), shard);
        registered.push(...selected);
      }
      assert.deepEqual(registered.sort(), [...names].sort());
    }
    const unsharded = spawnSync(
      process.execPath,
      ["--test", "--test-concurrency=1", "--test-reporter=tap", ...fixtures],
      {
        encoding: "utf8",
        env: Object.fromEntries(
          Object.entries(env).filter(([key]) => key !== "FOOM_ELECTRON_SHARD"),
        ),
      },
    );
    assert.equal(unsharded.status, 0, unsharded.stdout + unsharded.stderr);
    assert.deepEqual(
      Array.from(unsharded.stdout.matchAll(/^ok \d+ - (.+)$/gm), (match) => match[1]).sort(),
      [...names].sort(),
    );
    const filtered = run("1/1", ["--test-name-pattern=^case 3$"]);
    assert.equal(filtered.status, 0, filtered.stdout + filtered.stderr);
    assert.match(filtered.stdout, /^ok \d+ - case 3$/m);
    for (const shard of [
      "",
      "0/2",
      "3/2",
      "1/0",
      "1/17",
      "all",
      "1.5/4",
      "NaN/4",
      "9007199254740993/4",
      "1/9007199254740993",
    ]) {
      const result = run(shard);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /FOOM_ELECTRON_SHARD/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
