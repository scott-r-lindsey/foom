const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = process.getBuiltinModule("node:os");
const { deadline, expect } = require("./test-policy.js");
const { boardPage, launchApp, removeAfterApps, assertAccessible } = require("./harness.js");

// POSIX script fixtures exercise the actual native resolver and execFile boundary.
// Windows' native executable policy is independently covered in forge-process tests.
test("first-run git and selected forge hosts share lazy readiness and recover on recheck", {
  skip: process.platform === "win32",
  timeout: deadline(60_000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-readiness-")));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const repo = path.join(home, "code", "project");
  const log = path.join(root, "forge.log");
  const state = path.join(root, "state.json");
  await Promise.all([mkdir(bin), mkdir(path.join(repo, ".git"), { recursive: true })]);
  await writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(log, "");
  await writeFile(state, JSON.stringify({ git: "ready", loggedOut: true }));
  await writeFile(
    path.join(bin, "git"),
    `#!${process.execPath}
const fs=require('node:fs'); const args=process.argv.slice(2); const state=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8'));
if(args[0]==='--version'){console.log(state.git==='malformed'?'PRIVATE_DIAGNOSTIC':'git version 2.45.0');process.exit(0);}
if(args[0]==='config' && args.includes('--get-regexp')){console.log('remote.origin.url https://github.com/o/r\\nremote.backup.url git@logged-out.example:o/r\\nremote.unknown.url https://unknown.example/o/r');process.exit(0);}
if(args[0]==='rev-parse' && args[1]==='--is-inside-work-tree') console.log('true');
else if(args[0]==='rev-parse' && args[1]==='--show-toplevel') console.log(process.cwd());
else process.exit(1);
`,
    { mode: 0o755 },
  );
  const forgeScript = `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]!=='auth'||args[1]!=='status')process.exit(3);
if(args.includes('logged-out.example')&&JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8')).loggedOut){console.error('PRIVATE_DIAGNOSTIC not logged in');process.exit(1);}process.exit(0);`;
  await writeFile(path.join(bin, "gh"), forgeScript, { mode: 0o755 });
  await writeFile(path.join(bin, "glab"), forgeScript, { mode: 0o755 });
  const config = path.join(home, ".foom", "config", "forges");
  await mkdir(config, { recursive: true });
  const manifest = JSON.parse(
    await readFile(path.join(__dirname, "../../src/shared/bundled-forges/github.json"), "utf8"),
  );
  manifest.id = "gitlab";
  manifest.name = "GitLab fixture";
  manifest.executables = ["glab"];
  await writeFile(path.join(config, "gitlab.json"), JSON.stringify(manifest));
  const app = await launchApp(context, { fixture: "first-run", home, env: { PATH: bin } });
  const page = await boardPage(app);
  const fixtureShell = path.join(root, "fixture-login-shell");
  await writeFile(
    fixtureShell,
    `#!/bin/sh\nexport PATH='${bin.replaceAll("'", "'\\''")}'\nexec /bin/bash --noprofile --norc -c "$2"\n`,
    { mode: 0o755 },
  );
  await app.evaluate((_electron, shell) => {
    const os = process.getBuiltinModule("node:os");
    const original = os.userInfo;
    os.userInfo = (...args) => ({ ...original(...args), shell });
  }, fixtureShell);

  assert.equal(await readFile(log, "utf8"), "", "No startup auth probe");
  await page.getByRole("button", { name: "Start preflight", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.evaluate(async (folder) => {
    await window.desktop.saveSetup({ codeFolder: folder });
  }, path.dirname(repo));
  // Register through the real sender-validated scan/apply capability, using only fixture paths.
  await page.evaluate(
    async ({ folder, repo }) => {
      await window.desktop.scanCode("readiness", folder, () => {});
      const update = await window.desktop.applyRepositories([repo]);
      if (update.failures.length) throw Error("Fixture registration failed");
      await window.desktop.saveSetup({
        forges: { github: true, gitlab: true },
        forgeHosts: { "github.com": "github", "logged-out.example": "gitlab" },
      });
    },
    { folder: path.dirname(repo), repo },
  );
  assert.equal(await readFile(log, "utf8"), "", "No probe during repository selection");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Not signed in", { exact: false })).toBeVisible();
  await expect(page.getByText("PR status is unavailable for this host")).toBeVisible();
  assert.doesNotMatch(await page.locator("main").innerText(), /PRIVATE_DIAGNOSTIC/);
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls, [
    ["auth", "status", "--hostname", "github.com"],
    ["auth", "status", "--hostname", "logged-out.example"],
  ]);
  await assertAccessible(page);
  await writeFile(state, JSON.stringify({ git: "malformed", loggedOut: false }));
  await page.getByRole("button", { name: "Recheck", exact: true }).click();
  await expect(page.getByText(/Git returned an invalid version/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Launch", exact: true })).toBeDisabled();
  await writeFile(state, JSON.stringify({ git: "ready", loggedOut: false }));
  await page.getByRole("button", { name: "Recheck", exact: true }).click();
  await expect(page.locator(".preflight-detail").filter({ hasText: /^Ready/ })).toHaveCount(3);
  await page.getByRole("button", { name: "Settings → Forges" }).first().click();
  await expect(page.getByRole("heading", { name: "Forges", exact: true })).toBeVisible();
  await expect(page.getByText("Ready", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Back to Go / no-go" }).click();
  await rm(path.join(bin, "glab"));
  await page.getByRole("button", { name: "Recheck", exact: true }).click();
  await expect(page.getByText("Not installed", { exact: false })).toBeVisible();
  // Remove the only fixture Git and replace the discovered login PATH with an empty fixture directory.
  const empty = path.join(root, "empty");
  await mkdir(empty);
  const shell = path.join(root, "login-shell");
  await writeFile(
    shell,
    `#!/bin/sh\nexport PATH='${empty.replaceAll("'", "'\\''")}'\nexec /bin/bash --noprofile --norc -c "$2"\n`,
    { mode: 0o755 },
  );
  await app.evaluate((_electron, shell) => {
    const os = process.getBuiltinModule("node:os");
    const original = os.userInfo;
    os.userInfo = (...args) => ({ ...original(...args), shell });
  }, shell);
  await rm(path.join(bin, "git"));
  await page.getByRole("button", { name: "Recheck", exact: true }).click();
  await expect(page.getByText(/Git is not installed/)).toBeVisible();
  await assert.rejects(
    page.evaluate(() => window.desktop.saveSetup({ setupComplete: true })),
    /foom-error:operation-failed/,
  );
});

test("readiness views share probes across windows and follow repository commits without reopening", {
  timeout: deadline(60_000),
}, async (context) => {
  const { gitSync } = require("../helpers/git.js");
  const { openSettingsScreen } = require("./harness.js");
  const app = await launchApp(context, { fixture: "repository" });
  const writer = await boardPage(app);
  const repository = (await writer.evaluate(() => window.desktop.workspace())).repositories[0].path;
  gitSync([
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-qm",
    "Fixture",
  ]);
  gitSync(["-C", repository, "remote", "add", "origin", "https://new-forge.test/team/project.git"]);
  await app.evaluate(({ app }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    globalThis.readinessProbeCalls = [];
    globalThis.fixtureForgeStatus = "ready";
    // Isolate the probe dependency; the profile owner, registry, IPC, query and UI stay real.
    load("./build/main/setup/readiness.js").checkReadiness = async (repositories) => {
      globalThis.readinessProbeCalls.push(repositories.length);
      return {
        git: "ready",
        platform:
          process.platform === "darwin"
            ? "macos"
            : process.platform === "win32"
              ? "windows"
              : "linux",
        forges: repositories.length
          ? [{ host: "new-forge.test", status: globalThis.fixtureForgeStatus }]
          : [],
      };
    };
  });
  await writer.evaluate(async (folder) => {
    await window.desktop.saveSetup({ codeFolder: folder });
    await window.desktop.scanCode("readiness-remove", folder, () => {});
    await window.desktop.applyRepositories([]);
  }, path.dirname(repository));
  await openSettingsScreen(writer);
  await writer
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Forges", exact: true })
    .click();
  await writer.evaluate(() => {
    window.offReadiness = window.desktop.subscribeView("readiness", {}, (snapshot) => {
      window.readinessSnapshot = snapshot;
    });
  });
  await writer.waitForFunction(() => window.readinessSnapshot?.data?.git === "ready");
  assert.deepEqual(await app.evaluate(() => globalThis.readinessProbeCalls), [0]);
  await writer.evaluate(() => window.desktop.appMenu.execute("new-window"));
  let observer;
  await expect
    .poll(() => {
      observer = app
        .windows()
        .find((page) => page !== writer && page.url() === "app://bundle/index.html");
      return Boolean(observer);
    })
    .toBe(true);
  await observer.waitForLoadState("domcontentloaded");
  await expect(observer.getByRole("button", { name: "Foom menu", exact: true })).toBeVisible();
  await openSettingsScreen(observer);
  await observer
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Forges", exact: true })
    .click();
  await observer.evaluate(() => {
    window.offReadiness = window.desktop.subscribeView("readiness", {}, (snapshot) => {
      window.readinessSnapshot = snapshot;
    });
  });
  await observer.waitForFunction(() => window.readinessSnapshot?.data?.git === "ready");
  assert.deepEqual(
    await app.evaluate(() => globalThis.readinessProbeCalls),
    [0],
    "Opening another window reuses the profile probe",
  );
  await writer.evaluate(
    async ({ folder, repository }) => {
      await window.desktop.scanCode("readiness-add", folder, () => {});
      await window.desktop.applyRepositories([repository]);
    },
    { folder: path.dirname(repository), repository },
  );
  for (const page of [writer, observer]) {
    await expect(page.getByText("new-forge.test", { exact: true })).toBeVisible();
    await page.waitForFunction(() => window.readinessSnapshot?.data?.forges[0]?.status === "ready");
  }
  // Registration's Git-only guard plus exactly one new shared readiness probe.
  assert.deepEqual(await app.evaluate(() => globalThis.readinessProbeCalls), [0, 0, 1]);
  await writer.evaluate(
    (repository) => window.desktop.createWorktree(repository, "ready-cache"),
    repository,
  );
  assert.deepEqual(
    await app.evaluate(() => globalThis.readinessProbeCalls),
    [0, 0, 1],
    "Worktree-only metadata does not repeat auth probes",
  );
  await app.evaluate(() => {
    globalThis.fixtureForgeStatus = "not-signed-in";
  });
  await observer.getByRole("button", { name: "Recheck", exact: true }).click();
  for (const page of [writer, observer]) {
    await page.waitForFunction(
      () => window.readinessSnapshot?.data?.forges[0]?.status === "not-signed-in",
    );
    await expect(page.getByText("Not signed in", { exact: false })).toBeVisible();
  }
  assert.deepEqual(
    await app.evaluate(() => globalThis.readinessProbeCalls),
    [0, 0, 1, 1],
    "A changed recheck is shared without probes from other windows",
  );
  await writer.evaluate(() => window.offReadiness());
  await observer.evaluate(() => window.offReadiness());
});
