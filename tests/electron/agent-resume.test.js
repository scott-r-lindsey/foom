const { gitSync: isolatedGit } = require("../helpers/git.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const { boardPage, launchApp, quitAndWait, removeAfterApps } = require("./harness.js");

for (const agent of ["claude", "codex", "agy"]) {
  test(`resumes exited ${agent} conversations in place after a Foom restart`, {
    timeout: deadline(60_000),
    skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
  }, async (context) => {
    const { chmod } = require("node:fs/promises");
    const root = await mkdtemp(path.join(tmpdir(), "foom-resume-"));
    removeAfterApps(context, root);
    const bin = path.join(root, "bin");
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    const profile = path.join(root, "profile");
    const argvFile = path.join(root, "argv.json");
    await Promise.all([mkdir(bin), mkdir(repo), mkdir(home)]);
    isolatedGit(["init", "-q", "-b", "main", repo]);
    isolatedGit([
      "-C",
      repo,
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ]);
    if (agent === "agy") {
      const plugin = path.join(home, ".gemini/config/plugins/foom");
      await mkdir(plugin, { recursive: true });
      await writeFile(
        path.join(plugin, "plugin.json"),
        JSON.stringify({ name: "foom", foomObserverVersion: 2 }),
      );
    }
    const conversation = "0199abcd-1234-7890-abcd-123456789abc";
    await writeFile(
      path.join(bin, agent),
      `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync, renameSync } = require("node:fs");
const args = process.argv.slice(2);
const agent = ${JSON.stringify(agent)};
if (args[0] === "--version") { console.log(agent === "claude" ? "2.1.300 (Claude Code)" : agent === "codex" ? "codex-cli 0.160.1" : "1.3.3"); process.exit(0); }
if (args[0] === "--help") { console.log("--settings <json> -c, --config <value> --no-alt-screen"); process.exit(0); }
if (args[0] === "plugin" && args[1] === "list") { console.log(JSON.stringify({ imports: [{ name: "foom" }] })); process.exit(0); }
const record = process.env.TEST_ARGV + "." + process.pid + ".tmp";
writeFileSync(record, JSON.stringify({ args, cwd: process.cwd(), token: process.env.FOOM_TOKEN, pid: process.pid }));
renameSync(record, process.env.TEST_ARGV);
const resumed = args.includes("--resume") || args.includes("resume") || args.includes("--conversation");
if (resumed) {
  console.log("RESUMED_CONVERSATION " + process.pid);
  process.stdin.setRawMode(true);
  process.stdin.on("data", () => process.exit(0));
} else if (agent === "agy") {
  const payload = JSON.stringify({ conversationId: ${JSON.stringify(conversation)}, fullyIdle: true, terminationReason: "NO_TOOL_CALL", transcriptPath: "/must/not/read" });
  const request = require("node:http").request(process.env.FOOM_HOOK_URL, { method: "POST", headers: { Authorization: process.env.FOOM_TOKEN, "X-Foom-Session": process.env.FOOM_SESSION, "X-Foom-Event": "Stop", "X-Foom-Sequence": "1", "Content-Type": "application/json" } }, response => {
    response.resume();
    response.on("end", () => { console.log("AGENT_EXITED"); process.exit(response.statusCode === 204 ? 0 : 1); });
  });
  request.on("error", error => { console.error(error.message); process.exit(1); });
  request.end(payload);
} else {
  const payload = agent === "claude" ? { session_id: ${JSON.stringify(conversation)}, hook_event_name: "Stop" } : { "thread-id": ${JSON.stringify(conversation)}, "turn-id": "turn-1", type: "agent-turn-complete" };
  let command, hookArgs, input;
  if (agent === "claude") {
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    command = "sh"; hookArgs = ["-c", settings.hooks.Stop[0].hooks[0].command]; input = JSON.stringify(payload);
  } else {
    const notify = args.find(arg => arg.startsWith("notify="));
    [command, ...hookArgs] = JSON.parse(notify.slice(7));
    hookArgs.push(JSON.stringify(payload));
  }
  const hook = spawn(command, hookArgs, { stdio: ["pipe", "ignore", "inherit"] });
  hook.stdin.end(input);
  hook.on("exit", () => { console.log("AGENT_EXITED"); process.exit(0); });
}
`,
    );
    await chmod(path.join(bin, agent), 0o755);
    const options = {
      fixture: "agent",
      args: [`--user-data-dir=${profile}`],
      env: { HOME: home, PATH: bin, TEST_ARGV: argvFile },
    };
    const app = await launchApp(context, options);
    const page = await boardPage(app);
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, repo);
    const id = await page.evaluate(async (agent) => {
      const repository = await window.desktop.addRepository();
      return window.desktop.startWorktree({
        repository: repository.path,
        branch: "resume-test",
        run: agent,
      });
    }, agent);
    await expect
      .poll(() =>
        page.evaluate(
          async (id) => (await window.desktop.workspace()).terminals.find((row) => row.id === id),
          id,
        ),
      )
      .toMatchObject({ exited: true, conversationId: conversation });
    const firstLaunch = JSON.parse(await readFile(argvFile, "utf8"));
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(path.join(profile, "sessions.json"), "utf8"))[0]
            ?.conversationId,
      )
      .toBe(conversation);
    await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
    const restoredApp = await launchApp(context, { ...options, fixture: "restored" });
    const restored = await boardPage(restoredApp);
    await expect
      .poll(() => restored.evaluate(async () => (await window.desktop.workspace()).terminals))
      .toMatchObject([{ id, exited: true, dormant: true, conversationId: conversation }]);
    const agentName =
      agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "Antigravity";
    await restored
      .getByRole("button", { name: `Actions for ${agentName} in resume-test`, exact: true })
      .click();
    await restored.getByRole("menuitem", { name: "Copy session ID", exact: true }).click();
    // Clipboard writing finishes before the source's inventory refresh and panel
    // dismissal. Wait for the actual details dialog to close before opening it again.
    await expect(
      restored.getByRole("dialog", { name: `${agentName} details and commands`, exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() => restoredApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(conversation);
    await restored
      .getByRole("button", { name: `Actions for ${agentName} in resume-test`, exact: true })
      .click();
    await restored.getByRole("menuitem", { name: /^Resume conversation/ }).click();
    await expect
      .poll(() => restored.evaluate(async () => (await window.desktop.workspace()).terminals))
      .toMatchObject([{ id, exited: false, conversationId: conversation }]);
    await expect(restored.locator(".xterm-rows")).toContainText("RESUMED_CONVERSATION");
    const resumedLaunch = JSON.parse(await readFile(argvFile, "utf8"));
    await expect(restored.locator(".xterm-rows")).toContainText(
      `RESUMED_CONVERSATION ${resumedLaunch.pid}`,
    );
    assert.deepEqual(resumedLaunch.args.slice(0, 2), [
      agent === "claude" ? "--resume" : agent === "codex" ? "resume" : "--conversation",
      conversation,
    ]);
    assert.equal(resumedLaunch.cwd, firstLaunch.cwd);
    assert.ok(firstLaunch.token);
    assert.ok(resumedLaunch.token);
    assert.notEqual(resumedLaunch.token, firstLaunch.token);
    await expect(restored.locator(".xterm-helper-textarea")).toBeFocused();
    await restored.locator(".xterm-helper-textarea").press("q");
    await expect
      .poll(() =>
        restored.evaluate(async () => (await window.desktop.workspace()).terminals[0]?.exited),
      )
      .toBe(true);
    await restored
      .getByRole("button", { name: `Actions for ${agentName} in resume-test`, exact: true })
      .click();
    await restored.getByRole("menuitem", { name: /^Resume conversation/ }).click();
    await expect
      .poll(() =>
        restored.evaluate(async () => (await window.desktop.workspace()).terminals[0]?.exited),
      )
      .toBe(false);
    await expect
      .poll(async () => JSON.parse(await readFile(argvFile, "utf8")).token)
      .not.toBe(resumedLaunch.token);
    const secondResume = JSON.parse(await readFile(argvFile, "utf8"));
    await expect(restored.locator(".xterm-rows")).toContainText(
      `RESUMED_CONVERSATION ${secondResume.pid}`,
    );
    await expect(restored.locator(".xterm-helper-textarea")).toBeFocused();
    await restored.locator(".xterm-helper-textarea").press("q");
    await expect
      .poll(() =>
        restored.evaluate(async () => (await window.desktop.workspace()).terminals[0]?.exited),
      )
      .toBe(true);
    await restored
      .getByRole("button", { name: `Actions for ${agentName} in resume-test`, exact: true })
      .click();
    await restored.getByRole("menuitem", { name: "Close", exact: true }).click();
    await expect
      .poll(() =>
        restored.evaluate(async () => (await window.desktop.workspace()).terminals.length),
      )
      .toBe(0);
    await expect
      .poll(async () => JSON.parse(await readFile(path.join(profile, "sessions.json"), "utf8")))
      .toEqual([]);
    assert.equal(await realpath(resumedLaunch.cwd), resumedLaunch.cwd);
  });
}

for (const [agent, form] of [
  ["claude", "--resume"],
  ["claude", "-r"],
  ["codex", "resume"],
  ["agy", "--conversation"],
]) {
  test(`pastes ${agent} ${form} in a checkout and retains rejected conversations`, {
    timeout: deadline(60_000),
    skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
  }, async (context) => {
    const { chmod } = require("node:fs/promises");
    const root = await mkdtemp(path.join(tmpdir(), "foom-pasted-"));
    removeAfterApps(context, root);
    const bin = path.join(root, "bin"),
      repo = path.join(root, "repo"),
      home = path.join(root, "home");
    const profile = path.join(root, "profile"),
      argvFile = path.join(root, "argv.json");
    await Promise.all([mkdir(bin), mkdir(repo), mkdir(home)]);
    isolatedGit(["init", "-q", "-b", "main", repo]);
    isolatedGit([
      "-C",
      repo,
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ]);
    await writeFile(
      path.join(bin, agent),
      `#!/usr/bin/env node
const { writeFileSync, renameSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.0.0"); process.exit(0); }
if (args[0] === "--help") { console.log("resume"); process.exit(0); }
if (args[0] === "plugin") { console.log("{}"); process.exit(0); }
const record = process.env.TEST_ARGV + ".tmp";
writeFileSync(record, JSON.stringify({ args, cwd: process.cwd() }));
renameSync(record, process.env.TEST_ARGV);
console.log("UNKNOWN_CONVERSATION " + args[1]);
process.exit(1);
`,
    );
    await chmod(path.join(bin, agent), 0o755);
    const app = await launchApp(context, {
      fixture: "agent",
      args: [`--user-data-dir=${profile}`],
      env: { HOME: home, PATH: bin, TEST_ARGV: argvFile },
    });
    const page = await boardPage(app);
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, repo);
    await page.evaluate(async () => {
      await window.desktop.addRepository();
    });
    const panel = page.getByRole("button", { name: "Actions for Main checkout", exact: true });
    await panel.click();
    await page.getByRole("menuitem", { name: "Resume conversation…", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Conversation ID or resume command" });
    await expect(input).toBeFocused();
    await input.fill(`${agent} ${form} external-123`);
    await input.press("Escape");
    await expect(input).toHaveCount(0);
    assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals.length, 0);
    await page.getByRole("menuitem", { name: "Resume conversation…", exact: true }).click();
    await input.fill(`${agent} ${form} external-123 --extra`);
    await input.press("Enter");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals.length, 0);
    await input.fill(`${agent} ${form} external-123`);
    await input.press("Enter");
    await expect
      .poll(() => page.evaluate(async () => (await window.desktop.workspace()).terminals))
      .toMatchObject([{ agent, exited: true, conversationId: "external-123" }]);
    await expect(page.locator(".xterm-rows")).toContainText("UNKNOWN_CONVERSATION external-123");
    const exitedRow = page.locator(".board-row[data-kind='agent']");
    await expect(exitedRow).toHaveAccessibleName(/Exited/);
    await expect(exitedRow.locator(".session-program")).toHaveText("exited");
    for (const bulb of [
      exitedRow.locator(".board-light"),
      page.locator(".tile-title .board-light"),
    ]) {
      await expect(bulb).toHaveAttribute("data-exited", "true");
      await expect(bulb).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(bulb).toHaveCSS("border-radius", "0px");
    }
    const record = JSON.parse(await readFile(argvFile, "utf8"));
    assert.deepEqual(record.args.slice(0, 2), [
      agent === "claude" ? "--resume" : form,
      "external-123",
    ]);
    assert.equal(record.cwd, await realpath(repo));
    const label = agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "Antigravity";
    await page.getByRole("button", { name: `Actions for ${label} in main`, exact: true }).click();
    await expect(page.getByRole("menuitem", { name: /^Resume conversation/ })).toBeVisible();
    await page.getByRole("menuitem", { name: "Copy session ID", exact: true }).click();
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("external-123");
  });
}
