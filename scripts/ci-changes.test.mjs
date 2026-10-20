import { gitSync, gitEnvironment } from "../tests/helpers/git.js";
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
    "pnpm-lock.yaml",
    ".npmrc",
    "tests/electron/terminal.test.js",
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

test("desktop jobs use four shards on every platform", () => {
  assert.deepEqual(desktopMatrix(), [
    { os: "ubuntu-24.04", shard: "1/4" },
    { os: "ubuntu-24.04", shard: "2/4" },
    { os: "ubuntu-24.04", shard: "3/4" },
    { os: "ubuntu-24.04", shard: "4/4" },
    { os: "windows-2025", shard: "1/4" },
    { os: "windows-2025", shard: "2/4" },
    { os: "windows-2025", shard: "3/4" },
    { os: "windows-2025", shard: "4/4" },
    { os: "macos-15", shard: "1/4" },
    { os: "macos-15", shard: "2/4" },
    { os: "macos-15", shard: "3/4" },
    { os: "macos-15", shard: "4/4" },
  ]);
  assert.deepEqual(desktopMatrix(["ubuntu-24.04"]), [
    { os: "ubuntu-24.04", shard: "1/4" },
    { os: "ubuntu-24.04", shard: "2/4" },
    { os: "ubuntu-24.04", shard: "3/4" },
    { os: "ubuntu-24.04", shard: "4/4" },
  ]);
});

test("draft pull requests run CI and desktop jobs start without waiting for static checks", async () => {
  const { readFileSync } = await import("node:fs");
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /pull_request:\n {4}types: \[opened, synchronize, reopened\]\n/);
  assert.doesNotMatch(workflow, /\.draft|ready_for_review|labeled|full-ci/);
  const desktop = workflow.split("\n  desktop:\n")[1].split("\n  platform:\n")[0];
  assert.match(desktop, /\n {4}needs: \[changes\]\n/);
  const quality = workflow.split("\n  quality:\n")[1];
  assert.match(quality, /\n {4}needs: \[changes, checks, unit, desktop, platform\]\n/);
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
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const directory = mkdtempSync(join(tmpdir(), "foom-ci-"));
  const isolatedEnv = gitEnvironment();
  const git = (...args) => gitSync(args, { cwd: directory }).toString().trim();
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

test("Electron shards and once-per-platform checks run independently with diagnostics", async () => {
  const { readFileSync } = await import("node:fs");
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const desktop = workflow.split("\n  desktop:\n")[1].split("\n  platform:\n")[0];
  const platform = workflow.split("\n  platform:\n")[1].split("\n  quality:\n")[0];
  const step = (job, name) => job.split(`      - name: ${name}\n`)[1].split("      - name:")[0];
  for (const name of [
    "Prepare Windows PowerShell runtime",
    "Test hooks and control storage with native OS tools",
    "Test Antigravity observer alone",
    "Test Git inventory paths on native filesystem",
    "Test preview containment on native filesystem",
    "Stamp nightly package version",
    "Package desktop application",
    "Verify macOS ad-hoc signature after packaging and fuses",
    "Test packaged terminal host on Linux",
    "Test packaged terminal host on macOS and Windows",
    "Upload unsigned development package",
  ]) {
    assert.ok(platform.includes(`      - name: ${name}\n`), name);
    assert.ok(!desktop.includes(`      - name: ${name}\n`), name);
  }
  assert.match(platform, /os: \[ubuntu-24.04, windows-2025, macos-15\]/);
  assert.doesNotMatch(platform, /matrix\.shard|FOOM_ELECTRON_SHARD/);
  assert.match(
    step(platform, "Test hooks and control storage with native OS tools"),
    /--no-file-parallelism/,
  );
  assert.match(
    step(platform, "Test Git inventory paths on native filesystem"),
    /--no-file-parallelism/,
  );
  assert.match(
    step(platform, "Test packaged terminal host on Linux"),
    /xvfb-run -a pnpm run test:packaged/,
  );
  assert.match(
    step(platform, "Verify macOS ad-hoc signature after packaging and fuses"),
    /codesign --verify --deep --strict/,
  );
  assert.match(desktop, /FOOM_ELECTRON_SHARD: \$\{\{ matrix\.shard \}\}/);
  assert.match(
    desktop,
    /name: electron-results-\$\{\{ matrix\.os \}\}-\$\{\{ strategy\.job-index \}\}/,
  );
  assert.match(platform, /name: platform-results-\$\{\{ matrix\.os \}\}/);
  for (const [job, diagnostic] of [
    [desktop, "Upload Electron timing and process diagnostics"],
    [platform, "Upload native and packaged timing and process diagnostics"],
  ]) {
    assert.match(job, /\n {4}needs: \[changes\]\n/);
    assert.match(job, /if: needs\.changes\.outputs\.desktop_required == 'true'/);
    assert.match(job, /fail-fast: false/);
    assert.match(step(job, "Prepare Linux display and sandbox"), /if: runner\.os == 'Linux'/);
    assert.match(step(job, diagnostic), /if: always\(\)/);
    assert.match(step(job, diagnostic), /if-no-files-found: error/);
    assert.match(step(job, diagnostic), /retention-days: 3/);
  }
});

test("nightly publication waits for the full gate and reuses companion job packages", async () => {
  const { readFileSync } = await import("node:fs");
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const platform = workflow.split("\n  platform:\n")[1].split("\n  quality:\n")[0];
  const nightly = workflow.split("\n  nightly:\n")[1];
  assert.match(nightly, /needs: \[changes, quality, macos-sign\]/);
  assert.match(nightly, /needs\.quality\.result == 'success'/);
  assert.match(nightly, /needs\.changes\.outputs\.desktop_required == 'true'/);
  assert.match(
    nightly,
    /gh run download "\$RUN_ID" --name Foom-ubuntu-24.04 --name Foom-windows-2025 --name Foom-macos-signed/,
  );
  assert.doesNotMatch(nightly, /pnpm run make/);
  assert.match(platform, /name: Foom-\$\{\{ matrix\.os \}\}/);
  assert.match(platform, /path: out\/make\/\*\*\/\*\.zip/);
  assert.match(platform, /retention-days: 3/);
  assert.doesNotMatch(platform, /permissions:|continue-on-error:/);
  const stamp = platform
    .split("      - name: Stamp nightly package version\n")[1]
    .split("      - name:")[0];
  assert.match(stamp, /github\.ref == 'refs\/heads\/main'/);
  assert.match(stamp, /github\.event_name == 'schedule'/);
  assert.match(stamp, /github\.event_name == 'workflow_dispatch' && inputs\.publish_nightly/);
  assert.ok(
    platform.indexOf("node scripts/nightly.mjs stamp") < platform.indexOf("run: pnpm run make"),
  );
  assert.ok(platform.indexOf("run: pnpm run make") < platform.indexOf("run: codesign --verify"));
  assert.ok(
    platform.indexOf("run: pnpm run test:packaged") <
      platform.indexOf("name: Upload unsigned development package"),
  );
});

test("Quality gate rejects failed, cancelled or skipped required desktop and platform jobs", {
  skip: process.platform === "win32",
}, async () => {
  const { readFileSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const quality = workflow.split("\n  quality:\n")[1].split("\n  mcp-probe:\n")[0];
  assert.match(quality, /if: always\(\)/);
  assert.match(quality, /PLATFORM: \$\{\{ needs\.platform\.result \}\}/);
  assert.match(quality, /DESKTOP: \$\{\{ needs\.desktop\.result \}\}/);
  const script = quality.split("        run: |\n")[1].replace(/^ {10}/gm, "");
  const run = (required, result, platform = required === "true" ? "success" : "skipped") =>
    spawnSync("bash", ["-e", "-c", script], {
      env: {
        ...process.env,
        CHANGES: "success",
        CHECKS: "success",
        UNIT: "success",
        DESKTOP_REQUIRED: required,
        DESKTOP: result,
        PLATFORM: platform,
      },
    }).status;
  assert.equal(run("true", "success"), 0);
  assert.equal(run("false", "skipped"), 0);
  // GitHub aggregates all twelve matrix jobs into needs.desktop.result.
  for (const { os, shard } of desktopMatrix()) {
    for (const result of ["failure", "cancelled", "skipped"]) {
      assert.notEqual(run("true", result), 0, `${os} ${shard}: ${result}`);
    }
  }
  for (const os of ["ubuntu-24.04", "windows-2025", "macos-15"]) {
    for (const result of ["failure", "cancelled", "skipped"]) {
      assert.notEqual(run("true", "success", result), 0, `${os}: ${result}`);
    }
  }
  for (const result of ["success", "failure", "cancelled"]) {
    assert.notEqual(run("false", "skipped", result), 0);
    assert.notEqual(run("false", result, "skipped"), 0);
  }
  assert.notEqual(run("", "success", "success"), 0);
});

test("dependency jobs enable pinned pnpm before caching and freeze every repository install", async () => {
  const { readFileSync } = await import("node:fs");
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(manifest.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal(manifest.scripts.audit, "pnpm audit --audit-level=low");
  assert.doesNotMatch(workflow, /\bnpm (?:ci|install|run)|\bnpx\b|cache: npm/);
  for (const name of ["checks", "unit", "desktop", "platform", "mcp-probe"]) {
    const job = workflow.split(`\n  ${name}:\n`)[1].split(/\n {2}[a-z-]+:\n/)[0];
    const enable = job.indexOf("run: corepack enable");
    const cache = job.indexOf("cache: pnpm");
    const install = job.indexOf("run: pnpm install --frozen-lockfile");
    assert.ok(enable >= 0 && cache > enable && install > cache, name);
  }
  const checks = workflow.split("\n  checks:\n")[1].split("\n  unit:\n")[0];
  assert.match(checks, /run: pnpm run audit/);
  assert.doesNotMatch(checks, /continue-on-error/);
  const npmrc = readFileSync(new URL("../.npmrc", import.meta.url), "utf8");
  assert.match(npmrc, /^node-linker=hoisted$/m);
  assert.match(npmrc, /^package-import-method=hardlink$/m);
  assert.deepEqual(manifest.pnpm.onlyBuiltDependencies, ["electron", "esbuild", "node-pty"]);
});
