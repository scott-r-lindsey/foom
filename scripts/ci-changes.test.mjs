import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopMatrix, detectDesktop, requiresDesktop } from "./ci-changes.mjs";

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

test("desktop jobs run every platform and shard Windows exactly twice", () => {
  assert.deepEqual(desktopMatrix(), [
    { os: "ubuntu-24.04", shard: "1/1" },
    { os: "windows-2025", shard: "1/2" },
    { os: "windows-2025", shard: "2/2" },
    { os: "macos-15", shard: "1/1" },
  ]);
  assert.deepEqual(desktopMatrix(["ubuntu-24.04"]), [{ os: "ubuntu-24.04", shard: "1/1" }]);
});

test("draft pull requests run CI and desktop jobs start without waiting for static checks", async () => {
  const { readFileSync } = await import("node:fs");
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /pull_request:\n {4}types: \[opened, synchronize, reopened\]\n/);
  assert.doesNotMatch(workflow, /\.draft|ready_for_review|labeled|full-ci/);
  const desktop = workflow.split("\n  desktop:\n")[1].split("\n  quality:\n")[0];
  assert.match(desktop, /\n {4}needs: \[changes\]\n/);
  const quality = workflow.split("\n  quality:\n")[1];
  assert.match(quality, /\n {4}needs: \[changes, checks, unit, desktop\]\n/);
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
      `desktop_required=false\ndesktop_matrix=${JSON.stringify(desktopMatrix())}\n`,
    );
    git("mv", "source.ts", "NOTICE");
    git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "rename");
    assert.equal(run(docs, git("rev-parse", "HEAD")).status, 0);
    assert.equal(
      readFileSync(outputPath, "utf8"),
      `desktop_required=true\ndesktop_matrix=${JSON.stringify(desktopMatrix())}\n`,
    );
    assert.notEqual(run("f".repeat(40), docs).status, 0);
    assert.equal(readFileSync(outputPath, "utf8"), "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Linux preparation skips installed packages and bounds missing-package downloads", {
  skip: process.platform === "win32",
}, async () => {
  const { readFileSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const step = workflow
    .split("- name: Prepare Linux display and sandbox\n")[1]
    .split("      # The full suite")[0];
  const script = step.split("        run: |\n")[1].replace(/^ {10}/gm, "");
  const stubs = `
dpkg-query() {
  if [[ "$*" == *xvfb && "$TEST_MISSING" == 1 ]]; then return 1; fi
  printf 'install ok installed'
}
sudo() {
  printf '%s\\n' "$*"
  if [[ "$*" == *update && "$TEST_UPDATE_FAIL" == 1 ]]; then return 17; fi
}
`;
  const run = (missing, failure = "0") =>
    spawnSync("bash", ["-e", "-c", stubs + script], {
      encoding: "utf8",
      env: { ...process.env, TEST_MISSING: missing, TEST_UPDATE_FAIL: failure },
    });
  const installed = run("0");
  assert.equal(installed.status, 0, installed.stderr);
  assert.doesNotMatch(installed.stdout, /apt-get/);
  assert.match(installed.stdout, /sysctl -w kernel.apparmor_restrict_unprivileged_userns=0/);
  const missing = run("1");
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(
    missing.stdout,
    /Acquire::Retries=1.*Acquire::http::Timeout=30.*Acquire::https::Timeout=30.*update/,
  );
  assert.match(missing.stdout, /install -y xvfb/);
  const failure = run("1", "1");
  assert.equal(failure.status, 17);
  assert.doesNotMatch(failure.stdout, /install -y|sysctl/);
});
