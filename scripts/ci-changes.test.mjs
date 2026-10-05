import assert from "node:assert/strict";
import { test } from "node:test";
import { allPlatforms, desktopPlatforms, detectDesktop, requiresDesktop } from "./ci-changes.mjs";

const base = "a".repeat(40);
const head = "b".repeat(40);

test("only explicitly allowed documentation and reference changes skip desktop", () => {
  assert.equal(
    requiresDesktop([
      "README.md",
      "LICENSE",
      "AGENTS.md",
      "NOTICE",
      "docs/architecture.md",
      "docs/mockups/board.html",
      "inspiration/example.ts",
      "spikes/herdr/run.cjs.txt",
    ]),
    false,
  );
  for (const path of [
    "src/main/main.ts",
    "package-lock.json",
    "tests/electron/app.test.js",
    "scripts/build.mjs",
    ".github/workflows/ci.yml",
    "new.config",
    "docs/build.js",
    "docs/board.html",
    "docs/mockups/nested/board.html",
    "docs/mockups/board.js",
    "other.md",
    "README.md\nsrc/main/main.ts",
  ]) {
    assert.equal(requiresDesktop(["README.md", path]), true, path);
  }
  assert.equal(requiresDesktop([]), true);
});

test("PRs compare the merge base while pushes compare their previous commit", () => {
  for (const eventName of ["pull_request", "push"]) {
    const event = {
      before: base,
      after: head,
      pull_request: { base: { sha: base }, head: { sha: head } },
    };
    assert.equal(
      detectDesktop(eventName, event, (range) => {
        assert.equal(range, `${base}${eventName === "pull_request" ? "..." : ".."}${head}`);
        return "docs/product.md\0LICENSE\0";
      }),
      false,
    );
  }
});

test("deleted or renamed source paths still require desktop validation", () => {
  assert.equal(
    detectDesktop("push", { before: base, after: head }, () => "src/deleted.ts\0docs/moved.md\0"),
    true,
  );
});

test("manual runs, unknown events, new branches, and empty diffs require desktop", () => {
  const unexpectedDiff = () => {
    throw new Error("Unexpected diff");
  };
  assert.equal(detectDesktop("workflow_dispatch", {}, unexpectedDiff), true);
  assert.equal(detectDesktop("unknown", {}, unexpectedDiff), true);
  assert.equal(
    detectDesktop("push", { before: "0".repeat(40), after: head }, unexpectedDiff),
    true,
  );
  assert.equal(
    detectDesktop("push", { before: base, after: head }, () => ""),
    true,
  );
});

test("pull requests run Linux only unless labelled full-ci", () => {
  assert.deepEqual(desktopPlatforms("pull_request", { pull_request: { labels: [] } }), [
    "ubuntu-24.04",
  ]);
  assert.deepEqual(desktopPlatforms("pull_request", {}), ["ubuntu-24.04"]);
  assert.deepEqual(
    desktopPlatforms("pull_request", { pull_request: { labels: [{ name: "roadmap" }] } }),
    ["ubuntu-24.04"],
  );
  assert.deepEqual(
    desktopPlatforms("pull_request", {
      pull_request: { labels: [{ name: "roadmap" }, { name: "full-ci" }] },
    }),
    allPlatforms,
  );
  for (const eventName of ["push", "schedule", "workflow_dispatch", "unknown"]) {
    assert.deepEqual(desktopPlatforms(eventName, {}), allPlatforms, eventName);
  }
});

test("nightly runs validate desktop only when main changed recently", () => {
  const unexpectedDiff = () => {
    throw new Error("Unexpected diff");
  };
  assert.equal(
    detectDesktop("schedule", {}, unexpectedDiff, () => `${head}\n`),
    true,
  );
  assert.equal(
    detectDesktop("schedule", {}, unexpectedDiff, () => ""),
    false,
  );
  assert.throws(
    () =>
      detectDesktop("schedule", {}, unexpectedDiff, () => {
        throw new Error("Missing history");
      }),
    /Missing history/,
  );
});

test("invalid payloads and unavailable history fail instead of granting a skip", () => {
  for (const event of [{}, { before: "--help", after: head }, { before: base, after: null }]) {
    assert.throws(() => detectDesktop("push", event), /comparison commit/);
  }
  assert.throws(() => detectDesktop("pull_request", {}), /comparison commit/);
  assert.throws(
    () =>
      detectDesktop("push", { before: base, after: head }, () => {
        throw new Error("Missing history");
      }),
    /Missing history/,
  );
});

test("CLI uses real Git history, includes renamed source paths, and emits no skip on failure", async () => {
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const directory = mkdtempSync(join(tmpdir(), "foom-ci-"));
  // Hooks export Git variables pointing at the parent repository/index.
  const isolatedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (...args) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", env: isolatedEnv }).trim();
  try {
    git("init", "--quiet");
    git("config", "user.name", "CI test");
    git("config", "user.email", "ci@example.invalid");
    writeFileSync(join(directory, "source.ts"), "export const value = 1;\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "initial");
    const initial = git("rev-parse", "HEAD");
    writeFileSync(join(directory, "README.md"), "Documentation\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "docs");
    const docs = git("rev-parse", "HEAD");
    const eventPath = join(directory, "event.json");
    const outputPath = join(directory, "output");
    const run = (before, after) => {
      writeFileSync(eventPath, JSON.stringify({ before, after }));
      writeFileSync(outputPath, "");
      return spawnSync(
        process.execPath,
        [fileURLToPath(new URL("./ci-changes.mjs", import.meta.url))],
        {
          cwd: directory,
          env: {
            ...isolatedEnv,
            GITHUB_EVENT_NAME: "push",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_OUTPUT: outputPath,
          },
          encoding: "utf8",
        },
      );
    };
    assert.equal(run(initial, docs).status, 0);
    assert.equal(
      readFileSync(outputPath, "utf8"),
      `desktop_required=false\ndesktop_platforms=${JSON.stringify(allPlatforms)}\n`,
    );
    git("mv", "source.ts", "NOTICE");
    git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "rename");
    assert.equal(run(docs, git("rev-parse", "HEAD")).status, 0);
    assert.equal(
      readFileSync(outputPath, "utf8"),
      `desktop_required=true\ndesktop_platforms=${JSON.stringify(allPlatforms)}\n`,
    );
    assert.notEqual(run("f".repeat(40), docs).status, 0);
    assert.equal(readFileSync(outputPath, "utf8"), "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
