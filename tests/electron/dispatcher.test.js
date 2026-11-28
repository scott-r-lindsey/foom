const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const { evidencePath } = require("../helpers/evidence.js");
const { tmpdir } = require("node:os");
const { chmod, mkdir, mkdtemp, realpath, readFile, writeFile } = require("node:fs/promises");
const { gitSync } = require("../helpers/git.js");
const { test } = require("./test-shard.js");
const { deadline, expect } = require("./test-policy.js");
const {
  boardPage,
  confirmationPage,
  FAKE_ORCHESTRATED_CLAUDE,
  launchApp,
  quitAndWait,
  removeAfterApps,
} = require("./harness.js");
const { waitForFixtureRecord } = require("./fixture-records.js");

async function fixture(context) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "d-")));
  removeAfterApps(context, root);
  const source = path.join(root, "src");
  const creds = path.join(root, "credentials");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const profile = path.join(root, "profile");
  await Promise.all([source, bin, home].map((directory) => mkdir(directory)));
  const projects = Object.fromEntries(
    ["billing", "infra", "ledger", "tools"].map((name) => [name, path.join(source, "teams", name)]),
  );
  const unregistered = path.join(source, "teams", "scratch");
  for (const cwd of [...Object.values(projects), unregistered]) {
    await mkdir(cwd, { recursive: true });
    gitSync(["init", "-q", "-b", "main"], { cwd });
    gitSync(
      [
        "-c",
        "user.name=Foom",
        "-c",
        "user.email=foom@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        "init",
      ],
      { cwd },
    );
  }
  const fake = FAKE_ORCHESTRATED_CLAUDE.replace(
    'process.stdout.write("FOOM_AGENT_READY',
    `
const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
const hook = require("node:child_process").spawn("sh", ["-c", settings.hooks.UserPromptSubmit[0].hooks[0].command], { stdio: ["pipe", "ignore", "inherit"] });
hook.stdin.end(JSON.stringify({ session_id: "dispatcher-fixture-" + path.basename(process.cwd()), hook_event_name: "UserPromptSubmit" }));
process.stdout.write("FOOM_AGENT_READY`,
  );
  await writeFile(path.join(bin, "claude"), fake);
  await chmod(path.join(bin, "claude"), 0o755);
  const launch = (restore = false) =>
    launchApp(context, {
      fixture: restore ? "restored" : "agent",
      args: [`--user-data-dir=${profile}`],
      env: { HOME: home, PATH: bin, TEST_FAKE_CREDENTIALS: creds },
    });
  const credentials = async (repo = "src") => {
    const file = `${creds}.${repo}`;
    await waitForFixtureRecord(file, [], context.signal);
    return JSON.parse(await readFile(file, "utf8"));
  };
  const app = await launch();
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, source);
  await page.evaluate(async (paths) => {
    await window.desktop.scanCode("dispatcher-fixture", null, () => {});
    await window.desktop.applyRepositories(paths);
  }, Object.values(projects));
  const section = page.getByRole("treeitem", { name: `Source directory ${source}`, exact: true });
  const sourceName = section.getByRole("button", { name: source, exact: true });
  await expect(sourceName).toHaveAttribute("title", source);
  const sourceLabel = sourceName.getByText(source, { exact: true });
  await expect(sourceLabel).toHaveCSS("white-space", "nowrap");
  await expect(sourceLabel).toHaveCSS("text-overflow", "ellipsis");
  await section.getByRole("button", { name: "Actions for source directory" }).click();
  await page.getByRole("menuitem", { name: "New Claude Code" }).click();
  const row = section.locator(".board-row");
  await expect(row).toHaveCount(1);
  return { app, page, launch, credentials, row, projects, unregistered };
}

function control(credentials) {
  return async (method, params = {}) => {
    const reply = await fetch(credentials.controlUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: 1, instanceId: credentials.instanceId, method, params }),
    });
    return JSON.parse(await reply.text());
  };
}

async function mcpTools(credentials) {
  let session;
  const send = async (method, params, id) => {
    const reply = await fetch(credentials.controlUrl.replace("/control/v1", "/mcp"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.controlToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session, "mcp-protocol-version": "2025-11-25" } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
    });
    if (method === "initialize") session = reply.headers.get("mcp-session-id");
    return reply.status === 202 ? undefined : JSON.parse(await reply.text());
  };
  await send(
    "initialize",
    {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "fixture", version: "1" },
    },
    1,
  );
  assert.ok(session);
  await send("notifications/initialized", {}, undefined);
  return send;
}

function consoleCall(credentials, ...args) {
  return promisify(execFile)(path.join(__dirname, "../../build/console/foom"), args, {
    env: {
      FOOM_CONTROL_URL: credentials.controlUrl,
      FOOM_CONTROL_TOKEN: credentials.controlToken,
      FOOM_CONTROL_INSTANCE: credentials.instanceId,
    },
  });
}

async function captureThemes(board, view, name) {
  if (!process.env.FOOM_UI_SCREENSHOTS) return;
  for (const theme of ["light", "dark"]) {
    await board.evaluate(
      (interfaceTheme) => window.desktop.saveSetup({ interfaceTheme }),
      `eclipse-${theme}`,
    );
    await expect
      .poll(() => view.evaluate(() => document.documentElement.style.colorScheme))
      .toBe(theme);
    await view.screenshot({
      path: evidencePath(`dispatcher/${name}-${theme}.png`),
      animations: "disabled",
    });
  }
}

async function elevate(app, page, row, takeScreenshot) {
  await row.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Elevate to dispatcher…" }).click();
  const confirm = await confirmationPage(app, "Elevate to dispatcher");
  const glyph = await confirm.locator(".glyph svg path").getAttribute("d");
  assert.ok(glyph);
  const options = confirm.getByRole("checkbox");
  await expect(options).toHaveCount(4);
  for (const name of ["infra", "ledger", "tools"]) {
    await expect(confirm.getByRole("checkbox", { name: path.join("teams", name) })).toBeVisible();
  }
  const option = confirm.getByRole("checkbox", { name: path.join("teams", "billing") });
  const heading = confirm.getByRole("heading", { name: /Pre-approved repositories/ });
  await expect(heading).toHaveText(/Pre-approved repositories\s*0$/);
  await option.check();
  await expect(heading).toHaveText(/Pre-approved repositories\s*1$/);
  const second = confirm.getByRole("checkbox", { name: path.join("teams", "infra") });
  await second.check();
  await expect(heading).toHaveText(/Pre-approved repositories\s*2$/);
  await second.uncheck();
  await expect(heading).toHaveText(/Pre-approved repositories\s*1$/);
  await takeScreenshot?.(confirm);
  await confirm.getByRole("button", { name: "Elevate", exact: true }).click();
  await expect(row).toContainText("Dispatcher");
  await expect(row.locator(".session-orchestration svg path")).toHaveAttribute("d", glyph);
}

function launchRequest(repo, key = path.basename(repo)) {
  return {
    repo,
    agent: "claude",
    prompt: "Review the test fixtures.",
    reason: "Check the release.",
    idempotencyKey: key,
  };
}

test("dispatcher elevation, pre-approved launch, launch grants and live demotion", {
  timeout: deadline(90_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  const { app, page, credentials, row, projects, unregistered } = await fixture(context);
  const sourceGrant = await credentials();
  const request = control(sourceGrant);
  const mcp = await mcpTools(sourceGrant);
  const { result: identity } = await request("whoami");
  assert.equal(identity.role, "agent");
  assert.deepEqual(identity.capabilities, ["whoami", "manual"]);
  assert.deepEqual(await request("elevate_dispatcher"), { error: "forbidden" });
  assert.equal(
    (await mcp("tools/call", { name: "elevate_dispatcher", arguments: {} }, 2)).result.isError,
    true,
  );
  await assert.rejects(consoleCall(sourceGrant, "elevate-dispatcher"), { code: 2 });
  await elevate(app, page, row, (confirm) => captureThemes(page, confirm, "elevate"));
  const tools = (await mcp("tools/list", {}, 3)).result.tools;
  const listed = tools.map((tool) => tool.name);
  assert.ok(listed.includes("repos"));
  assert.ok(!listed.includes("create_worktree"));
  const promptSchema = tools.find((tool) => tool.name === "prompt").inputSchema;
  assert.deepEqual(Object.keys(promptSchema.properties).sort(), ["id", "idempotencyKey", "text"]);
  const waitSchema = tools.find((tool) => tool.name === "wait_for").inputSchema;
  assert.deepEqual(Object.keys(waitSchema.properties).sort(), ["after", "ids", "timeoutMs"]);
  assert.equal(waitSchema.properties.ids.minItems, 1);
  assert.equal(waitSchema.properties.ids.maxItems, 16);
  assert.deepEqual(
    (await request("whoami")).result.tools.find((tool) => tool.name === "wait_for"),
    {
      name: "wait_for",
      cli: "foom wait-for ID... [--after JSON_ID_TO_REVISION] [--timeout-ms 0-30000]",
    },
  );
  assert.equal(JSON.parse((await consoleCall(sourceGrant, "repos")).stdout).result.untrusted, true);
  const inventory = (await request("repos")).result?.repos;
  assert.deepEqual(
    inventory.map((entry) => entry.repo),
    Object.values(projects),
  );
  assert.deepEqual(
    inventory.filter((entry) => entry.preApproved).map((entry) => entry.repo),
    [projects.billing],
  );
  assert.deepEqual(await request("launch_orchestrator", launchRequest(unregistered)), {
    error: "not_found",
  });
  const launch = await request("launch_orchestrator", launchRequest(projects.billing));
  assert.equal(launch.result?.status, "succeeded", JSON.stringify(launch));
  const first = await request("launch_orchestrator", launchRequest(projects.billing));
  assert.equal(first.result?.resultId, launch.result?.resultId);
  const occupied = await request(
    "launch_orchestrator",
    launchRequest(projects.billing, "occupied"),
  );
  assert.equal(occupied.result?.status, "failed");
  assert.equal(occupied.result?.reason, "refused");
  const waited = await consoleCall(
    sourceGrant,
    "wait-for",
    launch.result.resultId,
    "--timeout-ms",
    "0",
  );
  assert.deepEqual(JSON.parse(waited.stdout).result.changed, [launch.result.resultId]);
  const billing = control(await credentials("billing"));
  assert.equal((await billing("whoami")).result?.role, "orchestrator");
  const sent = await billing("handoff", {
    status: "done",
    summary: "Fixture reviewed.",
    idempotencyKey: "fixture-report",
  });
  assert.equal(sent.result?.seq, 1);
  const read = await request("read_handoff", { id: launch.result.resultId, seq: 1 });
  assert.equal(read.result?.summary, "Fixture reviewed.");
  assert.equal(read.result?.untrusted, true);
  await expect(row).toContainText("1 orchestrators · 1 repos");

  for (const method of [
    "create_worktree",
    "launch",
    "tail",
    "open_preview",
    "board_answer",
    "board_post",
  ])
    assert.deepEqual(await request(method), { error: "forbidden" }, method);
  for (const [repo, choice, status] of [
    ["infra", "Allow once", "succeeded"],
    ["ledger", "Allow and add to dispatcher repos", "succeeded"],
    ["tools", "Don't launch", "declined"],
  ]) {
    const pending = await request("launch_orchestrator", launchRequest(projects[repo]));
    assert.equal(pending.result?.status, "pending_confirmation");
    await page.getByRole("button", { name: "1 decision needed from you", exact: true }).click();
    const stepper = page.getByRole("dialog", { name: /decisions$/ });
    await expect(
      stepper.getByText(`Launch Claude Code orchestrator in ${path.join("teams", repo)}`, {
        exact: true,
      }),
    ).toBeVisible();
    assert.equal(await stepper.getByLabel("Other answer").count(), 0);
    if (repo === "infra") await captureThemes(page, page, "grant");
    await stepper.getByRole("radio", { name: choice, exact: true }).check();
    await stepper.getByRole("button", { name: "Next", exact: true }).click();
    await stepper.getByRole("button", { name: /Submit/ }).click();
    await expect
      .poll(
        async () => (await request("operation_status", { idempotencyKey: repo })).result?.status,
      )
      .toBe(status);
    await expect(stepper).toHaveCount(0);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }
  const repos = (await request("repos")).result?.repos;
  assert.equal(repos.find((item) => item.repo === projects.infra).preApproved, false);
  assert.equal(repos.find((item) => item.repo === projects.ledger).preApproved, true);
  assert.deepEqual(repos.find((item) => item.repo === projects.tools).orchestrators, []);
  await captureThemes(page, page, "sidebar");
  await row.getByRole("button", { name: /Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Demote", exact: true }).click();
  await expect(row).not.toContainText("Dispatcher");
  assert.deepEqual(await request("repos"), { error: "forbidden" });
  assert.equal((await mcp("tools/call", { name: "repos", arguments: {} }, 4)).result.isError, true);
  assert.equal((await billing("whoami")).result?.role, "orchestrator");
});

test("dispatcher restart restores launch grants and adopted orchestrators", {
  timeout: deadline(90_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  const { app, page, launch, credentials, row, projects } = await fixture(context);
  const beforeRestart = await credentials();
  const request = control(beforeRestart);
  await elevate(app, page, row);
  const { result } = await request("launch_orchestrator", launchRequest(projects.billing));
  assert.equal(result.status, "succeeded");
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.desktop.workspace()).terminals
            .filter((row) => row.kind === "agent")
            .filter((row) => row.conversationId).length,
      ),
    )
    .toBe(2);
  const exitedId = result.resultId;
  const billing = control(await credentials("billing"));
  const handoff = await billing("handoff", {
    status: "done",
    summary: "Read this after restart.",
    idempotencyKey: "restart-report",
  });
  assert.equal(handoff.result?.seq, 1);
  const stopped = await request("stop", { id: exitedId, idempotencyKey: "stop-before-restart" });
  assert.equal(stopped.result?.status, "succeeded");
  await expect
    .poll(async () => (await request("session_state", { id: exitedId })).result?.state)
    .toBe("exited");
  const report = (await request("read_handoff", { id: exitedId })).result;
  assert.equal(report?.summary, "Read this after restart.");
  const replacement = await request(
    "launch_orchestrator",
    launchRequest(projects.billing, "replacement-before-restart"),
  );
  assert.equal(replacement.result?.status, "succeeded");
  const replacementId = replacement.result.resultId;
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.desktop.workspace()).terminals.find((entry) => entry.id === id)
            ?.conversationId,
        replacementId,
      ),
    )
    .toBeTruthy();
  await quitAndWait(app, async () => {
    await app.evaluate(({ app }) => app.quit());
    const dialog = await confirmationPage(app, /^Quit with/);
    await dialog.getByRole("button", { name: "Stop all and quit" }).click();
  });
  const reopened = await launch(true);
  const restored = await boardPage(reopened);
  await expect(restored.getByText("1 orchestrators · 1 repos")).toBeVisible();
  await expect
    .poll(async () => (await credentials()).instanceId)
    .not.toBe(beforeRestart.instanceId);
  const current = control(await credentials());
  assert.equal((await current("whoami")).result?.role, "dispatcher");
  const { repos } = (await current("repos")).result;
  assert.equal(repos.find((row) => row.repo === projects.billing).preApproved, true);
  assert.equal(
    repos.find((row) => row.repo === projects.billing).orchestrators[0].id,
    replacementId,
  );
  assert.deepEqual(await current("read_handoff", { id: exitedId }), { result: report });
  const state = await current("session_state", { id: exitedId });
  assert.equal(state.result?.state, "exited");
  const waited = await current("wait_for", { ids: [exitedId] });
  assert.deepEqual(waited.result?.changed, [exitedId]);
  assert.equal(waited.result?.sessions[0].state, "exited");
  assert.deepEqual(await current("stop", { id: exitedId, idempotencyKey: "stop-after-restart" }), {
    error: "not_found",
  });
});
