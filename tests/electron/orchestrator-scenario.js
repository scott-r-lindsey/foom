const { sizeTileBoard } = require("./tile-fixture.js");
const { evidencePath } = require("../helpers/evidence.js");
const { FAKE_GH } = require("../helpers/forge-cli.js");
const { gitSync: isolatedGit } = require("../helpers/git.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtemp, rename } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  FAKE_ORCHESTRATED_CLAUDE,
  assertAccessible,
  boardPage,
  approvalPage,
  clickApproval,
  launchApp,
  openSettingsScreen,
  removeAfterApps,
} = require("./harness.js");

// Each scenario owns its app/profile and cleanup; no state crosses test boundaries.
async function runOrchestratorScenario(context, cliOnly, phase) {
  const { chmod, mkdir, readdir, readFile, symlink, writeFile } = require("node:fs/promises");
  const { existsSync } = require("node:fs");
  // Match macOS's longer temporary paths and smaller content viewport in the
  // packaged cleanup case, including on Linux, so removal disclosures wrap.
  const compactCleanup = cliOnly && phase === "cleanup";
  const root = await mkdtemp(
    path.join(
      tmpdir(),
      compactCleanup
        ? "foom-orchestrator-long-temporary-prefix-for-wrapped-removal-disclosures-"
        : "foom-orchestrator-",
    ),
  );
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "app");
  const home = path.join(root, "home");
  await mkdir(bin);
  await mkdir(repo);
  await mkdir(home);
  const wakeFixture = FAKE_ORCHESTRATED_CLAUDE.replace(
    "let childTurns = 0;",
    `let childTurns = 0;
let wakeMode = "idle";
let wakes = 0;
let cancels = 0;
let permissionOpen = false;
let raceArmed = false;
const renderWake = () => process.stdout.write("\\x1b[2J\\x1b[H────\\r\\n❯");
const hookReady = () => {
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
  const command = settings.hooks.Stop[0].hooks[0].command;
  const hook = require("node:child_process").spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "ignore", "ignore"] });
  hook.stdin.end(JSON.stringify({ session_id: "wake-fixture", hook_event_name: "Stop" }));
  hook.on("exit", () => record("wake-ready", JSON.stringify({ mode: wakeMode })));
};`,
  ).replace(
    '  if (key.toString() === "q") process.exit(0);',
    `  if (key.toString() === "q") process.exit(0);
  if (!isChild) {
    const text = key.toString();
    if (["I", "P", "R", "L"].includes(text)) {
      wakeMode = text === "P" ? "permission" : text === "R" ? "race" : text === "L" ? "lost-working" : "idle";
      permissionOpen = wakeMode === "permission";
      raceArmed = wakeMode === "race";
      if (wakeMode === "permission") process.stdout.write("\\x1b[2J\\x1b[HAllow permission? Enter to approve");
      else if (wakeMode === "lost-working") process.stdout.write("\\x1b[2J\\x1b[HWorking interrupt");
      else renderWake();
      hookReady();
      return;
    }
    // Arm an input-state transition without redrawing. The menu opens at the
    // next input, after Foom's screen check and before that key is interpreted.
    if (raceArmed) { permissionOpen = true; raceArmed = false; }
    if (text === "\\x1b") {
      cancels++;
      if (permissionOpen) { permissionOpen = false; record("wake-denied", "denied"); process.stdout.write("\\x1b[2J\\x1b[HPermission cancelled"); }
      else renderWake();
      record("wake-cancels", String(cancels));
      return;
    }
    if (text.includes("Foom: child events")) {
      if (permissionOpen) record("wake-approved", "BUG");
      wakes++; record("wake-lines", JSON.stringify({ wakes, text })); return;
    }
    record("wake-unexpected", text); return;
  }`,
  );
  const waitingFixture = FAKE_ORCHESTRATED_CLAUDE.replace(
    '  if (key.toString() === "q") process.exit(0);',
    `  if (key.toString() === "q") process.exit(0);
  if (!isChild && ["w", "i", "?"].includes(key.toString())) {
    const title = key.toString() === "w" ? "◐ Working" : "✳ Claude Code";
    const line = key.toString() === "?" ? "Continue? (y/n)" : "Ready";
    process.stdout.write("\\x1b[2J\\x1b[H\\x1b]0;" + title + "\\x07" + line + "\\r\\n");
    return;
  }`,
  );
  await writeFile(
    path.join(bin, "claude"),
    phase === "wake"
      ? wakeFixture
      : ["waiting", "unread"].includes(phase)
        ? waitingFixture
        : ["resume", "resume-revoked"].includes(phase)
          ? FAKE_ORCHESTRATED_CLAUDE.replace(
              'process.stdout.write("FOOM_AGENT_READY',
              `
const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
const hook = require("node:child_process").spawn("sh", ["-c", settings.hooks.UserPromptSubmit[0].hooks[0].command], { stdio: ["pipe", "ignore", "inherit"] });
hook.stdin.end(JSON.stringify({ session_id: "saved-1081", hook_event_name: "UserPromptSubmit" }));
process.stdout.write("FOOM_AGENT_READY`,
            )
          : FAKE_ORCHESTRATED_CLAUDE,
  );
  if (cliOnly) {
    await writeFile(
      path.join(bin, "agy"),
      FAKE_ORCHESTRATED_CLAUDE.replace("2.1.296 (Claude Code)", "1.2.13 (Antigravity)")
        .replace("--mcp-config <configs...>", "--prompt-interactive <prompt>")
        .replace(
          'if (args[0] === "--help") { console.log(',
          'if (args[0] === "--help") { console.error(',
        )
        .replace('Load MCP servers"); process.exit(0);', 'Load MCP servers"); process.exit(2);'),
    );
    await chmod(path.join(bin, "agy"), 0o755);
  }
  // Screen-only Codex stand-in: no hooks/MCP advertised and no notifier consent.
  const providerScreens = {
    "@": "Selected model is at capacity",
    "#": "■ rate limit exceeded: Please try again in 10s.",
    $: "Approaching rate limits\nSwitch to gpt-6-luna for lower credit usage?\nKeep current model\nenter select · esc back",
  };
  await writeFile(
    path.join(bin, "codex"),
    FAKE_ORCHESTRATED_CLAUDE.replace("2.1.296 (Claude Code)", "codex-cli 0.160.1")
      .replace("--settings <file-or-json>  Load settings", "--no-alt-screen")
      .replace(
        "  if (isChild) {",
        `  if (isChild && ${JSON.stringify(providerScreens)}[key.toString()]) {
        process.stdout.write("\\x1b[2J\\x1b[H" + ${JSON.stringify(providerScreens)}[key.toString()].replaceAll("\\n", "\\r\\n") + "\\r\\n");
        return;
      }
      if (isChild) {`,
      ),
  );
  await chmod(path.join(bin, "codex"), 0o755);
  await chmod(path.join(bin, "claude"), 0o755);
  // Only the fake agent and system tools: real agents on PATH write their own state when probed.
  await symlink(process.execPath, path.join(bin, "node"));
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Foom", "-c", "user.email=foom@example.com", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const forgeState = path.join(root, "decision-forge.json");
  const decisionHead = "a".repeat(40);
  const decisionForge = async (headRefOid) => {
    const temporary = `${forgeState}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        pr: { headRefOid, headRefName: "decision-head" },
        checks: [{ bucket: "pass" }],
      }),
    );
    await rename(temporary, forgeState);
  };
  if (phase === "decisions") {
    git("remote", "add", "origin", "https://github.com/fixture/offline.git");
    await writeFile(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
    await decisionForge(decisionHead);
    await writeFile(
      path.join(repo, "shots.html"),
      `<!doctype html>
      <meta charset="utf-8"><meta http-equiv="refresh" content="0; url=/escape.html">
      <style>body { background: rgb(38, 70, 120); color: white; padding: 18px; font: 18px sans-serif }</style>
      <h1>Approvals · 3</h1><p>Two clean removals · One checkout has local files</p>
      <script>document.body.style.background = "red"; window.top.location = "app://bundle/index.html";</script>
      <a href="/escape.html">Open outside this preview</a>`,
    );
    await writeFile(
      path.join(repo, "escape.html"),
      '<body style="background: green">Navigated</body>',
    );
    const outside = path.join(root, "outside.html");
    await writeFile(outside, '<body style="background: green">Outside checkout</body>');
    await symlink(outside, path.join(repo, "outside.html"));
  }
  const credentials = path.join(root, "credentials.json");
  const app = await launchApp(context, {
    fixture: "agent",
    ...(phase === "pressure"
      ? {
          hostResources: {
            cores: 4,
            load: [4, 0, 0],
            memoryTotal: 16 * 1024 ** 3,
            memoryAvailable: 8 * 1024 ** 3,
          },
        }
      : {}),
    args: [`--user-data-dir=${path.join(root, "user-data")}`],
    env: {
      HOME: home,
      PATH: phase === "decisions" ? [bin, "/usr/bin", "/bin"].join(path.delimiter) : bin,
      ...(phase === "decisions" ? { TEST_FORGE_STATE: forgeState } : {}),
      TEST_FAKE_CREDENTIALS: credentials,
      TEST_CHILD_INPUT: phase === "children" ? "1" : "0",
    },
  });
  const page = await boardPage(app);
  if (compactCleanup) {
    await app.evaluate(({ BrowserWindow }) => {
      const board = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      // Linux lacks macOS's title-bar inset at the same outer minimum height.
      // Set the fixture's minimum explicitly so native clamping cannot hide it.
      board.setMinimumSize(900, 612);
      board.setContentSize(900, 612);
    });
    await expect.poll(() => page.evaluate(() => innerHeight)).toBe(612);
  }
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, repo);
  const repository = await page.evaluate(async () => (await window.desktop.addRepository()).path);
  const claude = await page.evaluate(async () =>
    (await window.desktop.scanAgents(true)).agents.find((agent) => agent.id === "claude"),
  );
  assert.equal(claude.mcp, true, `Fake agent lacks MCP: ${JSON.stringify(claude)}`);
  const read = async (name) => JSON.parse(await readFile(`${credentials}.${name}`, "utf8"));

  await page.evaluate(
    ({ repository, run }) =>
      window.desktop.sidebarCommand({ kind: "launch", repository, worktree: repository, run }),
    { repository, run: cliOnly ? "agy" : "claude" },
  );
  await expect
    .poll(() => existsSync(`${credentials}.app`), { timeout: deadline(15000) })
    .toBe(true);
  const parent = await read("app");
  // Per-launch MCP with an environment-sourced header; no token in argv or the file.
  if (cliOnly) {
    assert.equal(parent.mcp, null);
    assert.ok(parent.args.includes("--prompt-interactive"));
    assert.ok(parent.args.some((arg) => arg.includes("foom whoami --json lists your current")));
  } else {
    assert.ok(parent.args.includes("--mcp-config"));
    const server = Object.values(parent.mcp.mcpServers)[0];
    assert.equal(server.headers.Authorization, "Bearer ${FOOM_CONTROL_TOKEN}");
  }
  assert.ok(!JSON.stringify(parent.args).includes(parent.controlToken));
  let requestId = 0;
  let parentId;
  let elevated = false;
  const directCall = async (token, method, params = {}) => {
    const response = await fetch(parent.controlUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, instanceId: parent.instanceId, method, params }),
    });
    return { status: response.status, body: await response.json() };
  };
  const call = async (token, method, params = {}) => {
    if (cliOnly && elevated && token === parent.controlToken && method !== "whoami") {
      const args = [method.replaceAll("_", "-")];
      if (params.branch) args.push(params.branch);
      if (params.worktreeId) args.push(params.worktreeId);
      if (params.id) args.push(params.id);
      if (params.ids) args.push(...params.ids);
      for (const [key, flag] of [
        ["idempotencyKey", "--idempotency-key"],
        ["agent", "--agent"],
        ["model", "--model"],
        ["effort", "--effort"],
        ["prompt", "--prompt"],
        ["lines", "--lines"],
        ["timeoutMs", "--timeout-ms"],
        ["revision", "--revision"],
        ["verdictId", "--verdict-id"],
        ["text", "--text"],
        ["keys", "--keys"],
      ])
        if (params[key] !== undefined) args.push(flag, String(params[key]));
      if (params.after) args.push("--after", JSON.stringify(params.after));
      const id = ++requestId;
      await page.evaluate(({ parentId, text }) => window.desktop.input(parentId, text), {
        parentId,
        text: JSON.stringify({ id, args }) + "\n",
      });
      const file = `${credentials}.response-${id}`;
      // One existing command budget covers transport and operation completion;
      // observing a CLI timeout must not start another full wait window.
      const expires = Date.now() + deadline(40000);
      const remaining = () => Math.max(1, expires - Date.now());
      // The fixture renames a fully written response into place after the CLI exits.
      await expect.poll(() => existsSync(file), { timeout: remaining() }).toBe(true);
      const result = JSON.parse(await readFile(file, "utf8"));
      const response = {
        status: result.code === 0 ? 200 : result.code === 3 ? 403 : 400,
        body: JSON.parse(result.stdout || result.stderr),
      };
      // A lost mutation response is explicitly ambiguous. Reconcile the same key
      // without repeating the mutation, within the existing command budget.
      if (result.code === 6 && response.body.error === "unknown_outcome" && params.idempotencyKey) {
        assert.equal(response.body.idempotencyKey, params.idempotencyKey);
        const lookup = () =>
          directCall(token, "operation_status", { idempotencyKey: params.idempotencyKey });
        const accepted = await lookup();
        if (accepted.status !== 200) return response;
        if (accepted.body.result.status === "running") {
          await expect
            .poll(
              async () => {
                const workspace = await page.evaluate(() => window.desktop.workspace());
                const role = workspace.terminals.find((row) => row.id === parentId)?.orchestration;
                return role?.history?.find((entry) => entry.id === accepted.body.result.operationId)
                  ?.status;
              },
              { timeout: remaining() },
            )
            .toMatch(/^(pending_confirmation|succeeded|failed|declined|cancelled|indeterminate)$/);
        }
        return lookup();
      }
      return response;
    }
    return directCall(token, method, params);
  };
  const ordinary = await call(parent.controlToken, "whoami");
  assert.equal(ordinary.body.result.role, "agent");
  assert.ok(!ordinary.body.result.capabilities.includes("launch"));
  parentId = ordinary.body.result.terminalId;
  assert.equal(
    (await call(parent.controlToken, "create_worktree", { idempotencyKey: "early", branch: "x" }))
      .status,
    403,
  );

  // Cache the MCP list before the human grants the role, as real clients do.
  let handoffSession;
  let handoffRequest = 0;
  const handoffMcp = async (method, params = {}) => {
    const response = await fetch(parent.controlUrl.replace("/control/v1", "/mcp"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${parent.controlToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(handoffSession ? { "Mcp-Session-Id": handoffSession } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(method.startsWith("notifications/") ? {} : { id: ++handoffRequest }),
        method,
        params,
      }),
    });
    assert.ok([200, 202].includes(response.status), `MCP ${method}: HTTP ${response.status}`);
    handoffSession ||= response.headers.get("mcp-session-id");
    return response.status === 202 ? undefined : (await response.json()).result;
  };
  if (phase === "handoff") {
    await handoffMcp("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "fixture", version: "1" },
    });
    await handoffMcp("notifications/initialized");
    const listed = await handoffMcp("tools/list");
    const readHandoff = listed.tools.find((tool) => tool.name === "read_handoff");
    assert.match(readHandoff?.description, /^Orchestrator only:/);
    const refused = await handoffMcp("tools/call", {
      name: "read_handoff",
      arguments: { id: "child" },
    });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /^forbidden: you are not this repository's.*call whoami/);
  }

  // The human grants the role from the session menu; the agent keeps running.
  const parentRow = page
    .locator(".session-entry")
    .filter({ has: page.locator(`[data-drag-session="${parentId}"]`) });
  await parentRow
    .locator(":scope > .board-row")
    .getByRole("button", { name: /^Actions for/ })
    .click();
  await page.getByRole("menuitem", { name: "Make orchestrator…" }).click();
  const confirmation = await approvalPage(app);
  await expect(
    confirmation.getByRole("heading", {
      name: `Make ${cliOnly ? "Antigravity" : "Claude Code"} the Foom orchestrator?`,
    }),
  ).toBeVisible();
  await expect(confirmation.getByText(/model provider/)).toBeVisible();
  const resumeDisclosure = confirmation.getByText(
    "Until Foom restarts, Resume in this exited tile can restore its role and children without asking again. Revoke cancels this.",
  );
  const restartDisclosure = confirmation.getByText(
    "A role running at quit is restored on launch without asking when “Restore sessions on launch” is on (the default).",
  );
  if (cliOnly) {
    await expect(restartDisclosure).toHaveCount(0);
    await expect(resumeDisclosure).toHaveCount(0);
    await expect(confirmation.getByText("Revoke orchestrator ends its access.")).toBeVisible();
  } else {
    await expect(restartDisclosure).toBeVisible();
    await expect(resumeDisclosure).toBeVisible();
    await expect(
      confirmation.getByText("Revoke orchestrator ends its access and cancels automatic recovery."),
    ).toBeVisible();
  }
  await expect(confirmation.getByText(/Re-granting this tile before Foom restarts/)).toBeVisible();
  if (phase === "resume-revoked")
    await confirmation.screenshot({ path: evidencePath("1081-resume-disclosure.png") });
  await clickApproval(
    confirmation,
    confirmation.getByRole("button", { name: "Approve · Make orchestrator", exact: true }),
  );
  await expect
    .poll(async () => (await call(parent.controlToken, "whoami")).body.result?.role)
    .toBe("orchestrator");
  elevated = true;
  const whoami = await call(parent.controlToken, "whoami");
  assert.ok(whoami.body.result.capabilities.includes("launch"));
  assert.equal(whoami.body.result.terminalId, parentId);

  if (phase === "decisions") {
    const control = async (method, params) => {
      const reply = await directCall(parent.controlToken, method, params);
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      return reply.body.result;
    };
    const created = await control("create_worktree", {
      branch: "decision-head",
      idempotencyKey: "decisions-worktree",
    });
    assert.equal(created.status, "succeeded");
    const repositoryId = whoami.body.result.repository;
    const subject = { pullRequest: 340, headSha: decisionHead };
    const options = [
      { id: "approve", label: "Approve screenshots", hint: "Use the current draft assets" },
      { id: "revise", label: "Request changes" },
    ];
    const posted = await control("board_post", {
      to: [repositoryId],
      title: "Approvals review",
      kind: "question",
      text: "Three decisions from the orchestrator",
      idempotencyKey: "decisions-first",
      questions: [
        {
          title: "Approve the approval queue screenshots?",
          detail: "The draft includes both Eclipse themes.",
          options,
          preview: { path: "shots.html" },
          subject,
        },
        { title: "Ship the site update?", options, preview: { path: "outside.html" } },
        { title: "How should I handle the draft?", options },
      ],
    });
    assert.equal(posted.status, "succeeded");
    const thread = posted.resultId;
    const board = () => control("board_read", { thread });
    await expect
      .poll(async () => (await board()).posts[0].decisions[0].status, {
        timeout: deadline(20000),
      })
      .toBe("open");
    const post = (await board()).posts[0].id;
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      window.setContentSize(1280, 900);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280);
    const pill = (count) =>
      page.getByRole("button", {
        name: `${count} ${count === 1 ? "decision" : "decisions"} needed from you`,
        exact: true,
      });
    const dialog = page.getByRole("dialog", { name: / · decisions/ });
    const theme = async (base) => {
      await page.evaluate(
        (mode) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${mode}` }),
        base,
      );
      await expect
        .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
        .toBe(base);
    };
    const screenshot = (name, base) =>
      page.screenshot({ path: evidencePath(`decisions-1297/${name}-${base}.png`) });
    await parentRow.locator(":scope > .board-row").click();
    await expect(parentRow).toContainText("3 decisions");
    await expect(page.getByRole("button", { name: "Open message board" })).toContainText(
      "3 decisions",
    );
    for (const base of ["light", "dark"]) {
      await theme(base);
      await expect(pill(3)).toBeVisible();
      await screenshot("pill", base);
      await pill(3).click();
      await expect(pill(3)).toBeHidden();
      await expect(
        dialog.getByRole("heading", { name: "Approve the approval queue screenshots?" }),
      ).toBeVisible();
      await expect(dialog.getByText("Checks passed", { exact: true })).toBeVisible();
      if (base === "dark")
        await expect(dialog.getByRole("radio", { name: /Approve screenshots/ })).toBeChecked();
      const preview = dialog.getByRole("img", { name: "Preview of shots.html" });
      await expect(preview).toBeVisible();
      const rgb = await preview.evaluate(async (image) => {
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        return Array.from(ctx.getImageData(canvas.width - 2, canvas.height - 2, 1, 1).data);
      });
      assert.deepEqual(
        rgb,
        [38, 70, 120, 255],
        "Contained HTML stayed on the original page with JavaScript disabled",
      );
      await expect(dialog.locator("iframe, webview, a")).toHaveCount(0);
      await screenshot("preview", base);
      await dialog.getByRole("radio", { name: /Approve screenshots/ }).check();
      await dialog.getByRole("button", { name: "Next" }).click();
      await expect(dialog.getByText("Preview unavailable", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Skip" }).click();
      await dialog.getByLabel("Other answer").fill("Keep it in draft for now");
      await dialog.getByRole("button", { name: "Next" }).click();
      await expect(dialog.getByText("Skipped · stays open")).toBeVisible();
      await expect(dialog.getByText("Keep it in draft for now")).toBeVisible();
      await screenshot("review", base);
      if (base === "light") {
        await dialog
          .getByRole("button", { name: "Change Approve the approval queue screenshots?" })
          .click();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
      }
    }
    const cursor = (await control("wait_for", { ids: [], timeoutMs: 0 })).board.event;
    const wait = control("wait_for", { ids: [], boardAfter: cursor, timeoutMs: 20000 });
    await dialog.getByRole("button", { name: "Submit 2 answers" }).click();
    await expect(dialog).toBeHidden();
    assert.equal((await wait).board.changed, true);
    const after = await board();
    assert.equal(after.posts.at(-1).author, "human");
    assert.deepEqual(after.posts.at(-1).answers, [
      { post, index: 0, option: "approve", subject },
      { post, index: 2, other: "Keep it in draft for now" },
    ]);
    const spoofed = await directCall(parent.controlToken, "board_post", {
      thread,
      kind: "answer",
      text: "forged",
      answers: after.posts.at(-1).answers,
      idempotencyKey: "spoof",
    });
    assert.equal(spoofed.status, 400);

    await pill(1).click();
    await expect(dialog.getByRole("heading", { name: "Ship the site update?" })).toBeVisible();
    assert.equal(
      (await control("board_resolve", { thread, post, idempotencyKey: "withdraw" })).status,
      "succeeded",
    );
    await expect(dialog.getByText("Withdrawn", { exact: true })).toBeVisible();
    await expect(dialog.locator("s")).toHaveText("Ship the site update?");
    await expect(dialog.getByRole("radio").first()).toBeDisabled();
    await dialog.getByRole("button", { name: "Hide" }).click();
    await expect(pill(1)).toHaveCount(0);

    assert.equal(
      (
        await control("board_post", {
          thread,
          kind: "question",
          text: "New decision",
          idempotencyKey: "stale-post",
          questions: [{ title: "Approve the current draft head?", options, subject }],
        })
      ).status,
      "succeeded",
    );
    await pill(1).click();
    await dialog.getByRole("radio", { name: /Approve screenshots/ }).check();
    await decisionForge("b".repeat(40));
    await page.evaluate(async () => {
      await window.desktop.saveSetup({ showPullRequests: false });
      await window.desktop.saveSetup({ showPullRequests: true });
    });
    await expect(dialog.getByText("Stale · PR head changed")).toBeVisible({
      timeout: deadline(20000),
    });
    await expect(dialog.getByRole("radio").first()).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Next" })).toBeDisabled();
    assert.equal((await board()).posts.at(-1).decisions[0].status, "stale");
    for (const base of ["light", "dark"]) {
      await theme(base);
      await screenshot("stale", base);
    }
    await dialog.getByRole("button", { name: "Hide" }).click();
    await expect(pill(1)).toHaveCount(0);
    return;
  }

  if (phase === "wake") {
    const tree = await call(parent.controlToken, "create_worktree", {
      idempotencyKey: "wake-tree",
      branch: "child-wake",
    });
    const launched = await call(parent.controlToken, "launch", {
      idempotencyKey: "wake-child",
      worktreeId: tree.body.result.resultId,
      agent: "claude",
      prompt: "fixture",
    });
    assert.equal(launched.body.result.status, "succeeded");
    await expect.poll(() => existsSync(`${credentials}.child-wake`)).toBe(true);
    const child = await read("child-wake");
    await openSettingsScreen(page);
    const toggle = page.getByRole("checkbox", { name: "Wake idle orchestrators on child events" });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    for (const base of ["light", "dark"]) {
      await page.evaluate(
        (base) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${base}` }),
        base,
      );
      await expect
        .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
        .toBe(base);
      await toggle.evaluate((node) => node.parentElement.scrollIntoView({ block: "start" }));
      await page
        .getByRole("region", { name: "Settings" })
        .screenshot({ path: evidencePath(`548/wake-settings-${base}.png`) });
    }
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.desktop.setupState())).settings.wakeOrchestrator,
      )
      .toBe(true);
    let report = 0;
    const handoff = () =>
      call(child.controlToken, "handoff", {
        status: "done",
        summary: "Untrusted report text must never be typed",
        idempotencyKey: `wake-report-${++report}`,
      });
    const mode = async (text, expected) => {
      await page.evaluate(({ parentId, text }) => window.desktop.input(parentId, text), {
        parentId,
        text,
      });
      await expect
        .poll(async () => {
          try {
            return JSON.parse(await readFile(`${credentials}.wake-ready`, "utf8")).mode;
          } catch {
            return "";
          }
        })
        .toBe(expected);
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.desktop.workspace())).terminals.find(
              (row) => row.id === parentId,
            )?.execution?.phase,
        )
        .toBe("idle");
    };
    await mode("P", "permission");
    await handoff();
    // Two retry periods establish that the visible menu receives no bytes.
    await new Promise((resolve) => setTimeout(resolve, 4500));
    assert.equal(existsSync(`${credentials}.wake-cancels`), false);
    assert.equal(existsSync(`${credentials}.wake-lines`), false);
    await mode("L", "lost-working");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(existsSync(`${credentials}.wake-cancels`), false);
    assert.equal(existsSync(`${credentials}.wake-lines`), false);
    await mode("R", "race");
    await expect.poll(() => existsSync(`${credentials}.wake-denied`)).toBe(true);
    assert.equal(existsSync(`${credentials}.wake-approved`), false);
    assert.equal(existsSync(`${credentials}.wake-lines`), false);
    // A fresh human grant drops the old queue/cooldown rather than replaying it.
    await page.evaluate(
      (id) => window.desktop.sidebarCommand({ kind: "revoke-orchestrator", id }),
      parentId,
    );
    const granting = page.evaluate(
      (id) => window.desktop.sidebarCommand({ kind: "make-orchestrator", id }),
      parentId,
    );
    const grantPage = await approvalPage(app);
    await clickApproval(
      grantPage,
      grantPage.getByRole("button", { name: "Approve · Make orchestrator", exact: true }),
    );
    await granting;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(existsSync(`${credentials}.wake-lines`), false);
    const nextReport = await handoff();
    assert.equal(nextReport.status, 200, JSON.stringify(nextReport.body));
    await mode("I", "idle");
    await expect.poll(() => existsSync(`${credentials}.wake-lines`)).toBe(true);
    const delivered = JSON.parse(await readFile(`${credentials}.wake-lines`, "utf8"));
    assert.equal(delivered.wakes, 1);
    assert.equal(
      delivered.text,
      "Foom: child events for child-wake. Call wait_for and read_handoff.\r",
    );
    assert.equal(existsSync(`${credentials}.wake-approved`), false);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(JSON.parse(await readFile(`${credentials}.wake-lines`, "utf8")).wakes, 1);
    return;
  }

  if (phase === "agy-prompt") {
    const tree = await call(parent.controlToken, "create_worktree", {
      idempotencyKey: "agy-help-tree",
      branch: "child-agy-help",
    });
    assert.equal(tree.body.result.status, "succeeded", JSON.stringify(tree.body));
    const launched = await call(parent.controlToken, "launch", {
      idempotencyKey: "agy-help-launch",
      worktreeId: tree.body.result.resultId,
      agent: "agy",
      prompt: "Summarize the README",
    });
    assert.equal(launched.body.result.status, "succeeded", JSON.stringify(launched.body));
    await expect.poll(() => existsSync(`${credentials}.child-agy-help`)).toBe(true);
    const child = await read("child-agy-help");
    const index = child.args.indexOf("--prompt-interactive");
    assert.ok(index >= 0);
    assert.ok(child.args[index + 1].includes("Summarize the README"));
    return;
  }

  if (phase === "pressure") {
    const tree = await call(parent.controlToken, "create_worktree", {
      idempotencyKey: "pressure-tree",
      branch: "pressure-child",
    });
    assert.equal(tree.body.result.status, "succeeded");
    const request = {
      idempotencyKey: "pressure-launch",
      worktreeId: tree.body.result.resultId,
      agent: "claude",
    };
    const busy = await call(parent.controlToken, "launch", request);
    assert.equal(busy.body.result.reason, "host_busy", JSON.stringify(busy.body));
    assert.equal(busy.body.result.status, "failed");
    assert.deepEqual(busy.body.result.pressure, {
      measured: true,
      loadPerCore: 1,
      memoryAvailable: 8 * 1024 ** 3,
      memoryTotal: 16 * 1024 ** 3,
      sessions: 1,
      reservations: 0,
      budget: 4,
    });
    assert.deepEqual((await call(parent.controlToken, "launch", request)).body, busy.body);
    const worktree = path.join(root, "human-pressure");
    git("worktree", "add", "-b", "human-pressure", worktree);
    // Use main's canonical checkout path, including macOS /var aliases.
    const humanWorktree = await page.evaluate(
      async (repository) =>
        (await window.desktop.worktrees(repository)).find(
          (tree) => tree.branch === "human-pressure",
        )?.path,
      repository,
    );
    assert.ok(humanWorktree);
    await page.evaluate(
      ({ repository, worktree }) =>
        window.desktop.sidebarCommand({ kind: "launch", repository, worktree, run: "claude" }),
      { repository, worktree: humanWorktree },
    );
    await expect
      .poll(() => existsSync(`${credentials}.human-pressure`), { timeout: deadline(15000) })
      .toBe(true);
    const rows = await page.evaluate(() => window.desktop.workspace());
    assert.equal(rows.terminals.filter((row) => row.kind === "agent" && !row.exited).length, 2);
    return;
  }

  if (phase === "board") {
    const site = path.join(root, "site");
    await mkdir(site);
    isolatedGit(["init", "-q", "-b", "main"], { cwd: site });
    isolatedGit(
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
      { cwd: site },
    );
    const sitePickerPath = path.join(root, "site-picker");
    await symlink(site, sitePickerPath, "dir");
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, sitePickerPath);
    const sitePath = await page.evaluate(async () => (await window.desktop.addRepository()).path);
    await page.evaluate(
      (repository) =>
        window.desktop.sidebarCommand({
          kind: "launch",
          repository,
          worktree: repository,
          run: "claude",
        }),
      sitePath,
    );
    await expect
      .poll(() => existsSync(`${credentials}.site`), { timeout: deadline(15000) })
      .toBe(true);
    const siteAgent = await read("site");
    const siteIdentity = await directCall(siteAgent.controlToken, "whoami");
    const siteId = siteIdentity.body.result.terminalId;
    assert.equal((await directCall(siteAgent.controlToken, "board_threads")).status, 403);
    await page
      .locator(".session-entry")
      .filter({ has: page.locator(`[data-drag-session="${siteId}"]`) })
      .locator(":scope > .board-row")
      .getByRole("button", { name: /^Actions for/ })
      .click();
    await page.getByRole("menuitem", { name: "Make orchestrator…" }).click();
    await expect(
      confirmation.getByRole("heading", { name: "Make Claude Code the Foom orchestrator?" }),
    ).toBeVisible();
    await clickApproval(
      confirmation,
      confirmation.getByRole("button", { name: "Approve · Make orchestrator", exact: true }),
    );
    await expect
      .poll(async () => (await directCall(siteAgent.controlToken, "whoami")).body.result?.role)
      .toBe("orchestrator");
    const repositories = (await directCall(parent.controlToken, "board_threads")).body.result
      .repositories;
    const siteRepository = repositories.find((repo) => repo.name === "site").id;
    const request = {
      to: [siteRepository],
      title: "Stable nightly release",
      kind: "request",
      text: "Can the site use the existing nightly URL and release metadata?",
      links: ["#973"],
      idempotencyKey: "board-request",
    };
    const created = (await directCall(parent.controlToken, "board_post", request)).body.result;
    assert.equal(created.status, "succeeded");
    const thread = created.resultId;
    const received = (await directCall(siteAgent.controlToken, "board_read", { thread })).body
      .result;
    assert.equal(received.untrusted, true);
    assert.equal(received.posts.length, 1);
    assert.equal(received.posts[0].author, `orchestrator:${whoami.body.result.repository}`);
    const decision = await directCall(siteAgent.controlToken, "board_post", {
      thread,
      kind: "decision-needed",
      text: "The existing URL is stable. May I start updating the site and capture new screenshots?",
      idempotencyKey: "board-decision",
    });
    assert.equal(decision.body.result.status, "succeeded");
    const denied = await directCall(parent.controlToken, "board_post", {
      thread,
      kind: "answer",
      text: "spoof",
      author: "human",
      idempotencyKey: "spoof",
    });
    assert.equal(denied.status, 400);
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      if (!window) throw new Error("Missing board window");
      window.setContentSize(1280, 900);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280);
    await page.getByRole("button", { name: "Open message board" }).click();
    const panel = page.getByRole("region", { name: "Message board", exact: true });
    await expect(panel.getByRole("button", { name: /Stable nightly release/ })).toContainText(
      "Decision needed",
    );
    for (const base of ["light", "dark"]) {
      await page.evaluate(
        (base) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${base}` }),
        base,
      );
      await expect
        .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
        .toBe(base);
      await panel.screenshot({ path: evidencePath(`message-board-973/list-${base}.png`) });
    }
    await panel.getByRole("button", { name: /Stable nightly release/ }).click();
    await expect(panel.getByText("The existing URL is stable.", { exact: false })).toBeVisible();
    for (const base of ["light", "dark"]) {
      await page.evaluate(
        (base) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${base}` }),
        base,
      );
      await expect
        .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
        .toBe(base);
      await panel.getByLabel("Reply", { exact: true }).fill("");
      await panel.screenshot({ path: evidencePath(`message-board-973/thread-${base}.png`) });
      await panel
        .getByLabel("Reply", { exact: true })
        .fill("Use the existing artifacts. Hold implementation until I approve it.");
      await panel.screenshot({ path: evidencePath(`message-board-973/reply-${base}.png`) });
      await assertAccessible(page);
    }
    await panel.getByRole("button", { name: "Post reply" }).click();
    await expect(
      panel
        .locator(".message-thread ol")
        .getByText("Use the existing artifacts. Hold implementation until I approve it.", {
          exact: true,
        }),
    ).toBeVisible();
    const human = (await directCall(parent.controlToken, "board_read", { thread })).body.result;
    assert.equal(human.posts.at(-1).author, "human");
    await panel.getByRole("button", { name: "Mark resolved" }).click();
    await expect(
      panel.locator(".message-thread > header").getByText("Resolved", { exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole("button", { name: "Mark resolved" })).toBeDisabled();
    assert.equal(
      (await directCall(siteAgent.controlToken, "board_read", { thread })).body.result.thread.state,
      "resolved",
    );
    await panel.getByRole("button", { name: "Close board" }).click();
    return;
  }

  const connection = async (id) =>
    (await page.evaluate(() => window.desktop.workspace())).terminals.find((row) => row.id === id)
      ?.mcpConnection;
  const connect = async (client) => {
    const response = await fetch(client.controlUrl.replace("/control/v1", "/mcp"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${client.controlToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" },
        },
      }),
    });
    assert.equal(response.status, 200);
    await response.json();
  };
  if (phase === "attachment") {
    if (!cliOnly) {
      // The fake client never calls MCP. CLI traffic cannot prove attachment.
      assert.equal(await connection(parentId), "connecting");
      await expect
        .poll(() => connection(parentId), { timeout: deadline(35000) })
        .toBe("not-connected");
      await parentRow
        .locator(":scope > .board-row")
        .getByRole("button", { name: /^Actions for/ })
        .click();
      await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
      await expect(page.getByText("Not connected", { exact: true })).toHaveAttribute(
        "data-tone",
        "failed",
      );
      await connect(parent);
      await expect.poll(() => connection(parentId)).toBe("connected");
      await expect(page.getByText("Connected", { exact: true })).toHaveAttribute(
        "data-tone",
        "neutral",
      );
      await page.keyboard.press("Escape");
    } else {
      assert.equal(await connection(parentId), undefined);
    }
  }

  if (phase !== "attachment") {
    if (phase === "children") {
      await openSettingsScreen(page);
      await page.getByRole("button", { name: "General", exact: true }).click();
      const limit = page.getByRole("spinbutton", { name: "Concurrent children per orchestrator" });
      await expect(limit).toHaveValue("4");
      await limit.fill("1");
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.desktop.setupState())).settings.concurrentChildren,
        )
        .toBe(1);
      await page.screenshot({
        path: evidencePath(`child-limit-${cliOnly ? "agy" : "claude"}.png`),
      });
      await assertAccessible(page);
      await page.keyboard.press("Escape");
    }
    if (phase === "children")
      await page.evaluate(() =>
        window.desktop.saveSetup({
          agentArguments: {
            claude: [
              "--append-system-prompt",
              "--model=literal-prompt",
              "--system-prompt",
              "--effort=high",
              "--model=old",
              "--effort",
              "low",
              "--verbose",
            ],
            codex: [],
            agy: [],
          },
        }),
      );
    const tree = await call(parent.controlToken, "create_worktree", {
      idempotencyKey: "tree-1",
      branch: "child-one",
    });
    assert.equal(tree.body.result.status, "succeeded");
    assert.deepEqual(
      (
        await call(parent.controlToken, "create_worktree", {
          idempotencyKey: "tree-1",
          branch: "child-one",
        })
      ).body,
      tree.body,
    );
    // Drop one completed launch response to exercise ambiguous delivery without
    // waiting for the full CLI timeout. Operation history must recover success.
    const lostLaunchResponse = cliOnly && phase === "children";
    if (lostLaunchResponse) {
      await app.evaluate(() => {
        const { ServerResponse } = process.getBuiltinModule("http");
        const end = ServerResponse.prototype.end;
        ServerResponse.prototype.end = function (...args) {
          const body = typeof args[0] === "string" ? JSON.parse(args[0]) : undefined;
          if (body?.result?.action === "launch" && body.result.status === "succeeded") {
            ServerResponse.prototype.end = end;
            this.destroy();
            return this;
          }
          return end.apply(this, args);
        };
      });
    }
    const launching = call(parent.controlToken, "launch", {
      idempotencyKey: "launch-1",
      worktreeId: tree.body.result.resultId,
      agent: "claude",
      prompt: "Summarize the README",
      ...(phase === "children" ? { model: "fixture-model", effort: "high" } : {}),
    });
    const launched = await launching;
    assert.equal(launched.status, 200, JSON.stringify(launched.body));
    assert.equal(launched.body.result.status, "succeeded", JSON.stringify(launched.body));
    if (lostLaunchResponse) {
      const file = `${credentials}.response-${requestId}`;
      const lost = JSON.parse(await readFile(file, "utf8"));
      assert.equal(lost.code, 6);
      assert.deepEqual(JSON.parse(lost.stderr), {
        error: "unknown_outcome",
        idempotencyKey: "launch-1",
      });
    }
    const childId = launched.body.result.resultId;
    if (phase === "resume-unsupported") {
      await page.evaluate((id) => window.desktop.input(id, "q"), parentId);
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.desktop.workspace())).terminals.find(
              (row) => row.id === parentId,
            )?.exited,
        )
        .toBe(true);
      await parentRow
        .locator(":scope > .board-row")
        .getByRole("button", { name: /^Actions for/ })
        .click();
      await expect(page.getByRole("menuitem", { name: "Close", exact: true })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Revoke orchestrator" })).toHaveCount(0);
      return;
    }
    if (["resume", "resume-revoked"].includes(phase)) {
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.desktop.workspace())).terminals.find(
              (row) => row.id === parentId,
            )?.conversationId,
        )
        .toBe("saved-1081");
      const oldToken = parent.controlToken;
      await page.evaluate((id) => window.desktop.input(id, "q"), parentId);
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.desktop.workspace())).terminals.find(
              (row) => row.id === parentId,
            )?.exited,
        )
        .toBe(true);
      const openParentMenu = () =>
        parentRow
          .locator(":scope > .board-row")
          .getByRole("button", { name: /^Actions for/ })
          .click();
      if (phase === "resume-revoked") {
        await openParentMenu();
        await expect(page.getByRole("menuitem", { name: "Revoke orchestrator" })).toBeVisible();
        await page.screenshot({
          path: evidencePath("1081-exited-revoke.png"),
          animations: "disabled",
        });
        await page.getByRole("menuitem", { name: "Revoke orchestrator" }).click();
        await expect
          .poll(
            async () =>
              (await page.evaluate(() => window.desktop.workspace())).terminals.find(
                (row) => row.id === parentId,
              )?.orchestration?.restoreOnResume,
          )
          .toBeUndefined();
      }
      await openParentMenu();
      if (phase === "resume-revoked")
        await expect(page.getByRole("menuitem", { name: "Revoke orchestrator" })).toHaveCount(0);
      await page.getByRole("menuitem", { name: /^Resume conversation/ }).click();
      await expect.poll(async () => (await read("app")).controlToken).not.toBe(oldToken);
      Object.assign(parent, await read("app"));
      assert.equal(
        (await directCall(parent.controlToken, "whoami")).body.result.role,
        phase === "resume" ? "orchestrator" : "agent",
      );
      assert.equal((await directCall(oldToken, "whoami")).status, 401);
      assert.equal(
        (await directCall(parent.controlToken, "tail", { id: childId })).status,
        phase === "resume" ? 200 : 403,
      );
      return;
    }

    if (phase === "unread") {
      const parentBoard = parentRow.locator(":scope > .board-row");
      // Launch replies before the renderer handles the background placement.
      // Consume that arrival before selecting the initially hidden parent, or
      // the child can add a column after selection and make split-right add a third.
      const childTile = page.locator(".terminal-tile").filter({
        has: page.locator(".tile-location", { hasText: "child-one" }),
      });
      await expect(childTile).toBeVisible();
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL() === "app://bundle/index.html")
          .focus();
      });
      await parentBoard.click();
      await expect
        .poll(
          async () => (await page.evaluate(() => window.desktop.windows.audio.state())).focusedId,
        )
        .toBe(parentId);
      // Placement now adds narrow columns; arrange a hidden child explicitly.
      await childTile.getByRole("button", { name: "Hide", exact: true }).click();
      await page.evaluate(() => window.desktop.appMenu.execute("tidy-tiles"));
      await expect(childTile).toHaveCount(0);
      await openSettingsScreen(page);
      await page.getByRole("button", { name: "General", exact: true }).click();
      const reminder = page.getByRole("spinbutton", {
        name: "Unread child reminder (minutes; 0 turns off)",
      });
      await expect(reminder).toHaveValue("5");
      await reminder.fill("1");
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.desktop.setupState())).settings.unreadChildMinutes,
        )
        .toBe(1);
      await page.keyboard.press("Escape");
      await expect
        .poll(
          async () => (await page.evaluate(() => window.desktop.windows.audio.state())).focusedId,
        )
        .toBe(parentId);
      await page.evaluate((id) => window.desktop.input(id, "w"), parentId);
      await expect(parentBoard).toHaveAttribute("data-state", "working");
      await sizeTileBoard(app, page);
      await page.evaluate(() => window.desktop.appMenu.execute("split-right"));
      await expect(page.locator(".terminal-tile")).toHaveCount(2);
      const childRow = page.locator(`[data-drag-session="${childId}"]`);
      await childRow.click();
      await expect
        .poll(
          async () => (await page.evaluate(() => window.desktop.windows.audio.state())).focusedId,
        )
        .toBe(childId);
      const stopped = await call(parent.controlToken, "stop", {
        id: childId,
        idempotencyKey: "unread-stop",
      });
      assert.equal(stopped.body.result.status, "succeeded");
      await expect(childRow).toHaveAttribute("data-exited", "true");
      await expect
        .poll(
          async () => (await page.evaluate(() => window.desktop.windows.audio.state())).focusedId,
        )
        .toBe(childId);
      try {
        await expect
          .poll(() => parentBoard.getAttribute("data-state"), { timeout: deadline(75000) })
          .toBe("needs_input");
      } catch (error) {
        context.diagnostic(
          JSON.stringify(
            await page.evaluate(async () => ({
              audio: await window.desktop.windows.audio.state(),
              terminals: (await window.desktop.workspace()).terminals.map((row) => ({
                id: row.id,
                state: row.state,
                execution: row.execution,
                exited: row.exited,
              })),
            })),
          ),
        );
        throw error;
      }
      await expect(parentBoard.locator(".board-reason")).toHaveText(
        "Child report unread · orchestration:unread",
      );
      await expect(parentBoard).toHaveAccessibleName(/Needs you/);
      const parentTile = page
        .locator(".terminal-tile")
        .filter({ has: page.locator(".tile-attention", { hasText: "Child report unread" }) });
      await expect(parentTile).toHaveAttribute("data-state", "needs_input");
      await expect(parentTile.locator(".board-light")).toHaveAttribute(
        "data-light-state",
        "needs_input",
      );
      await assertAccessible(page);
      await page.screenshot({
        path: evidencePath("unread-child-attention.png"),
        animations: "disabled",
      });
      await parentTile.getByRole("button", { name: "Dismiss incorrect attention flag" }).click();
      await expect(parentBoard).toHaveAttribute("data-state", "working");
      await expect(parentTile).toHaveCount(0);
      await expect(page.getByText("Unable to record feedback. Try again.")).toHaveCount(0);
      return;
    }
    if (phase === "waiting") {
      const parentBoard = parentRow.locator(":scope > .board-row");
      const input = (text) =>
        page.evaluate(({ id, text }) => window.desktop.input(id, text), { id: parentId, text });
      await input("w");
      await expect(parentBoard).toHaveAttribute("data-state", "working");
      await input("i");
      await expect(parentBoard).toHaveAttribute("data-state", "waiting");
      await expect(parentBoard.locator(".board-reason")).toHaveText("Waiting on 1");
      await expect(parentBoard.locator(".board-light")).toHaveAttribute(
        "data-light-state",
        "waiting",
      );
      await expect(parentBoard).toHaveAccessibleName(/Waiting on 1/);
      const waitingColor = await parentBoard
        .locator(".board-light")
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      await input("?");
      await expect(parentBoard).toHaveAttribute("data-state", "needs_input");
      assert.notEqual(
        await parentBoard
          .locator(".board-light")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
        waitingColor,
      );
      await input("w");
      await expect(parentBoard).toHaveAttribute("data-state", "working");
      await input("i");
      await expect(parentBoard).toHaveAttribute("data-state", "waiting");
      await assertAccessible(page);
      await page.screenshot({
        path: evidencePath("orchestrator-waiting.png"),
        animations: "disabled",
      });
      const stop = await call(parent.controlToken, "stop", {
        id: childId,
        idempotencyKey: "waiting-stop",
      });
      assert.equal(stop.body.result.status, "succeeded");
      await expect(parentBoard).toHaveAttribute("data-state", "quiet_ok");
      return;
    }
    if (phase === "handoff") {
      await expect.poll(() => existsSync(`${credentials}.child-one`)).toBe(true);
      const child = await read("child-one");
      assert.match(child.args.at(-1), /Before stopping.*CI fails/s);
      const summary = "CI failed. <img src=x onerror=alert(1)>\n**Plain child-authored text**";
      const file = path.join(root, "handoff.txt");
      await writeFile(file, summary);
      const state = (await call(parent.controlToken, "session_state", { id: childId })).body.result;
      const waitDeadline = Date.now() + deadline(30000);
      const execFile = require("node:util").promisify(require("node:child_process").execFile);
      const cli = async (credential, args) => {
        const { stdout } = await execFile("foom", [...args, "--json"], {
          env: {
            PATH: credential.cliPath,
            FOOM_CONTROL_URL: credential.controlUrl,
            FOOM_CONTROL_TOKEN: credential.controlToken,
            FOOM_CONTROL_INSTANCE: credential.instanceId,
          },
          timeout: deadline(10000),
        });
        return JSON.parse(stdout).result;
      };
      const waitFrom = async (revision) => ({
        body: {
          result: await cli(parent, [
            "wait-for",
            childId,
            "--until-event",
            "--after",
            JSON.stringify({ [childId]: revision }),
            "--timeout",
            "30",
          ]),
        },
      });
      const waiting = waitFrom(state.revision);
      const report = await cli(child, [
        "handoff",
        "--status",
        "failed",
        "--summary-file",
        file,
        "--link",
        "https://example.com/pull/514",
        "--idempotency-key",
        "report",
      ]);
      assert.equal(report.seq, 1);
      // A fresh snapshot after acknowledgement must already contain the report.
      assert.deepEqual(
        (await call(parent.controlToken, "session_state", { id: childId })).body.result.handoff,
        { seq: 1, status: "failed" },
      );
      let woke = (await waiting).body.result;
      // Startup output and settled verdicts also change the revision. A wait
      // resolved before the report was accepted keeps that earlier snapshot.
      while (woke.sessions[0].handoff === undefined) {
        context.diagnostic(`Pre-handoff wait snapshot: ${JSON.stringify(woke)}`);
        assert.equal(woke.timedOut, false);
        assert.deepEqual(woke.changed, [childId]);
        assert.ok(Date.now() < waitDeadline, "Handoff was not observed before the wait deadline");
        woke = (await waitFrom(woke.sessions[0].revision)).body.result;
      }
      assert.equal(woke.timedOut, false);
      assert.deepEqual(woke.changed, [childId]);
      assert.deepEqual(woke.sessions[0].handoff, { seq: 1, status: "failed" });
      assert.ok(!JSON.stringify(woke).includes(summary));
      // The original MCP connection can use the previously cached tool after elevation.
      const pulled = await handoffMcp("tools/call", {
        name: "read_handoff",
        arguments: { id: childId },
      });
      assert.equal(pulled.isError, false);
      assert.equal(pulled.structuredContent.summary, summary);
      assert.equal((await cli(parent, ["read-handoff", childId, "--seq", "1"])).summary, summary);
      const row = page.locator(`[data-drag-session="${childId}"]`);
      await expect(row.locator(".session-handoff")).toHaveText("■ failed");
      await row
        .locator("..")
        .getByRole("button", { name: /^Actions for/ })
        .click();
      await expect(page.locator(".handoff-summary")).toHaveText(summary);
      await expect(page.locator(".handoff-summary img")).toHaveCount(0);
      await expect(page.locator(".handoff-links a")).toHaveAttribute(
        "href",
        "https://example.com/pull/514",
      );
      await assertAccessible(page);
      await page.screenshot({
        path: evidencePath("child-handoff.png"),
        animations: "disabled",
      });
      await page.getByRole("textbox", { name: "Filter repositories and sessions" }).hover();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Foom menu" }).click();
      await page.getByRole("menuitem", { name: "Developer", exact: true }).click();
      await page.getByRole("menuitem", { name: "Action log", exact: true }).click();
      await page.getByLabel("Action", { exact: true }).selectOption("handoff");
      const history = page.getByRole("region", { name: "Action history" });
      await expect(history.getByText("Handoff #1 (failed)")).toBeVisible();
      await expect(history).not.toContainText(summary);
      const log = await page.evaluate(() =>
        window.desktop.actionLog({ search: "", action: "handoff", status: "", offset: 0 }),
      );
      assert.equal(log.entries[0].actorId, childId);
      assert.equal(log.entries[0].parentId, parentId);
      assert.equal(existsSync(`${credentials}.reply-child-one`), false);
      await page.getByRole("searchbox").press("Escape");
      await page.evaluate(
        (id) => window.desktop.sidebarCommand({ kind: "take-over", id }),
        childId,
      );
      assert.equal(
        (
          await call(child.controlToken, "handoff", {
            status: "done",
            summary: "later",
            idempotencyKey: "later",
          })
        ).body.error,
        "no_parent",
      );
      assert.equal(
        (await call(parent.controlToken, "read_handoff", { id: childId })).body.error,
        "not_found",
      );
      return;
    }

    if (phase === "children") {
      const extraTree = await call(parent.controlToken, "create_worktree", {
        idempotencyKey: "tree-limit",
        branch: "child-limit",
      });
      assert.equal(extraTree.body.result.status, "succeeded");
      const refusedLaunch = await call(parent.controlToken, "launch", {
        idempotencyKey: "launch-limit",
        worktreeId: extraTree.body.result.resultId,
        agent: "claude",
      });
      assert.equal(refusedLaunch.status, 400);
      assert.equal(refusedLaunch.body.error, "capacity");
      await openSettingsScreen(page);
      await page.getByRole("button", { name: "General", exact: true }).click();
      await expect(
        page.getByRole("spinbutton", { name: "Concurrent children per orchestrator" }),
      ).toHaveValue("1");
      await page.keyboard.press("Escape");
      await expect.poll(() => existsSync(`${credentials}.child-one`)).toBe(true);
      const child = await read("child-one");
      assert.deepEqual(child.args.slice(0, 9), [
        "--append-system-prompt",
        "--model=literal-prompt",
        "--system-prompt",
        "--effort=high",
        "--verbose",
        "--model",
        "fixture-model",
        "--effort",
        "high",
      ]);
      assert.equal(child.args.filter((arg) => arg === "--model").length, 1);
      const selectedState = (await call(parent.controlToken, "session_state", { id: childId })).body
        .result;
      assert.deepEqual(selectedState.selection, { model: "fixture-model", effort: "high" });
      assert.match(
        child.args.at(-1),
        /^Task from your Foom orchestrator.*\n\nSummarize the README$/s,
      );
      const childIdentity = (await call(child.controlToken, "whoami")).body.result;
      assert.equal(childIdentity.role, "agent");
      assert.equal(childIdentity.parentId, parentId);
      assert.equal(await connection(childId), "connecting");
      await connect(child);
      await expect.poll(() => connection(childId)).toBe("connected");
      // An idle fixture accepts a follow-up, then permission keys, without a review window.
      await expect
        .poll(
          async () =>
            (await call(parent.controlToken, "session_state", { id: childId })).body.result.state,
        )
        .toBe("quiet_ok");
      const followup = { id: childId, idempotencyKey: "prompt-1", text: "src/app.ts" };
      const sent = await call(parent.controlToken, "prompt", followup);
      assert.equal(sent.body.result.status, "succeeded");
      await expect.poll(() => existsSync(`${credentials}.reply-child-one`)).toBe(true);
      assert.equal(
        await readFile(`${credentials}.reply-child-one`, "utf8"),
        "\x1b[200~src/app.ts\x1b[201~\r",
      );
      assert.equal(
        (await call(parent.controlToken, "prompt", followup)).body.result.status,
        "succeeded",
      );
      await expect
        .poll(
          async () =>
            (await call(parent.controlToken, "session_state", { id: childId })).body.result
              .attentionKind,
        )
        .toBe("permission");
      const keys = await call(parent.controlToken, "send_keys", {
        id: childId,
        idempotencyKey: "keys-1",
        keys: ["y", "enter"],
      });
      assert.equal(keys.body.result.status, "succeeded");
      await expect.poll(() => existsSync(`${credentials}.reply-child-one-2`)).toBe(true);
      assert.equal(await readFile(`${credentials}.reply-child-one-2`, "utf8"), "y\r");
      assert.equal(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some(
            (window) => window.isVisible() && window.webContents.getURL().includes("confirmation"),
          ),
        ),
        false,
      );
      // No grandchildren: a child's credential cannot reach orchestration.
      assert.equal(
        (
          await call(child.controlToken, "create_worktree", {
            idempotencyKey: "x",
            branch: "nested",
          })
        ).status,
        403,
      );
      await expect
        .poll(
          async () => {
            const tail = await call(parent.controlToken, "tail", { id: childId, lines: 5 });
            return tail.body.result?.lines?.join("\n") ?? "";
          },
          { intervals: [1100], timeout: deadline(15000) },
        )
        .toContain("FOOM_AGENT_READY");
      const waited = await call(parent.controlToken, "wait_for", { ids: [childId], timeoutMs: 0 });
      assert.equal(waited.body.result.sessions[0].id, childId);
      // Children belong to their own checkout and retain an independent light.
      const childRow = page.locator(`[data-drag-session="${childId}"]`);
      const parentSession = page.locator(`[data-drag-session="${parentId}"]`);
      const childEntry = childRow.locator("..");
      const parentEntry = parentSession.locator("..");
      await expect(childRow).toHaveCount(1);
      await childRow.click();
      const worker = page.locator(".tile-title").getByRole("img", { name: "Worker" });
      await expect(worker).toBeVisible();
      await expect(worker.locator("title")).toHaveText(
        "Child of " + (await parentSession.locator(".session-name").innerText()),
      );
      const childMark = childRow.locator('.session-robot-mark[data-kind="rx"]');
      const parentMark = parentSession.locator('.session-robot-mark[data-kind="tx"]');
      await expect(childMark).toHaveAttribute("aria-hidden", "true");
      await expect(parentMark).toHaveCount(1);
      await expect(childRow).toHaveAttribute(
        "title",
        `Child of ${cliOnly ? "Antigravity" : "Claude Code"}`,
      );
      const checkout = childRow.locator('xpath=ancestor::div[@role="group"][1]/..');
      await expect(checkout.locator(".worktree-row").first()).toContainText("child-one");
      await expect(checkout.locator(`[data-drag-session="${parentId}"]`)).toHaveCount(0);
      await expect(childRow.locator(".board-light")).toHaveCount(1);
      await parentSession.focus();
      await expect(childEntry).toHaveAttribute("data-related", "true");
      await expect(childMark).toHaveAttribute("data-related", "true");
      await childRow.focus();
      await expect(parentEntry).toHaveAttribute("data-related", "true");
      await expect(parentMark).toHaveAttribute("data-related", "true");
      await page.getByRole("textbox", { name: "Filter repositories and sessions" }).focus();
      await childRow.hover();
      await expect(parentEntry).toHaveAttribute("data-related", "true");
      await expect(parentMark).toHaveAttribute("data-related", "true");
      await parentSession.hover();
      await expect(childEntry).toHaveAttribute("data-related", "true");
      await expect(childMark).toHaveAttribute("data-related", "true");
      await childRow.focus();
      // Finish the hover interaction before the later Settings checks: its panel
      // otherwise follows the stationary pointer and covers Settings navigation.
      await page.getByRole("textbox", { name: "Filter repositories and sessions" }).hover();
      await page.keyboard.press("Escape");
      await expect(page.locator(".row-menu")).toHaveCount(0);
      if (phase === "children") {
        await parentSession.click();
        await expect(childMark).toHaveAttribute("data-related", "true");
        await expect(childMark.locator(".robot-wave-inner")).toHaveCSS(
          "animation-name",
          "robot-receive",
        );
        await childRow.focus();
        await expect(parentMark.locator(".robot-wave-inner")).toHaveCSS(
          "animation-name",
          "robot-transmit",
        );
        await expect(childRow).toHaveCSS("box-shadow", "none");
        if (!cliOnly) {
          for (const colorScheme of ["light", "dark"]) {
            await parentSession.focus();
            await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
            await expect(page.locator("html")).toHaveCSS("color-scheme", colorScheme);
            await expect(childMark.locator(".robot-wave-inner")).toHaveCSS(
              "animation-name",
              "none",
            );
            await expect(childMark).toHaveCSS(
              "color",
              colorScheme === "light" ? "rgb(91, 43, 217)" : "rgb(155, 107, 255)",
            );
            for (const scale of [80, 100, 150]) {
              await page.evaluate(
                (interfaceScale) => window.desktop.saveSetup({ interfaceScale }),
                scale,
              );
              await expect(childMark).toBeVisible();
              await expect(parentMark).toBeVisible();
              if (process.env.FOOM_SCREENSHOTS)
                await page.screenshot({
                  path: evidencePath(`477-marks-${colorScheme}-${scale}.png`),
                  animations: "disabled",
                });
            }
            await page.evaluate(() => window.desktop.saveSetup({ interfaceScale: 100 }));
            await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
            await expect(childMark).toBeVisible();
            await expect(parentMark).toBeVisible();
            const markBox = await childMark.boundingBox();
            const rowBox = await childRow.boundingBox();
            assert.ok(
              markBox &&
                rowBox &&
                markBox.x >= rowBox.x &&
                markBox.x + markBox.width <= rowBox.x + rowBox.width,
            );
            if (process.env.FOOM_SCREENSHOTS)
              await page.screenshot({
                path: evidencePath(`477-marks-${colorScheme}-compact.png`),
                animations: "disabled",
              });
            await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
          }
          await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
        }
        await page.getByRole("textbox", { name: "Filter repositories and sessions" }).hover();
        await page.keyboard.press("Escape");
        await expect(page.locator(".row-menu")).toHaveCount(0);
      }
      await assertAccessible(page);
    }
    const stopped = await call(parent.controlToken, "stop", {
      idempotencyKey: "stop-1",
      id: childId,
    });
    assert.equal(stopped.body.result.status, "succeeded");
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.desktop.workspace())).terminals.find(
            (row) => row.orchestration?.role === "child",
          )?.exited,
      )
      .toBe(true);

    if (phase === "children" && !cliOnly) {
      const childRow = page.locator(`[data-drag-session="${childId}"]`);
      const parentRow = page.locator(`[data-drag-session="${parentId}"]`);
      const mark = childRow.locator(".session-robot-mark");
      await expect(childRow).toHaveAttribute("data-exited", "true");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      for (const mode of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: mode });
        await parentRow.focus();
        await expect(mark).toHaveAttribute("data-related", "true");
        await expect(mark).toHaveAttribute("data-animated", "false");
        await expect(mark.locator(".robot-wave-inner")).toHaveCSS("animation-name", "none");
        await expect(mark).toHaveCSS(
          "color",
          mode === "light" ? "rgb(91, 43, 217)" : "rgb(155, 107, 255)",
        );
        if (process.env.FOOM_POLISH_SCREENSHOTS === "1") {
          await childRow.screenshot({
            path: evidencePath(`1045/exited-related-child-${mode}.png`),
            animations: "disabled",
          });
        }
      }
    }

    if (phase === "cleanup") {
      // Both transports exercise profile opt-in, real Git proofs and automatic completion.
      // Keep an unrelated review pending: automatic policy must not wait behind it
      // or treat that queue's existing consent as its own approval.
      const pendingReview = await call(parent.controlToken, "remove_worktree", {
        idempotencyKey: "remove-1",
        worktreeId: tree.body.result.resultId,
      });
      assert.equal(pendingReview.body.result.status, "pending_confirmation");
      await expect(confirmation.locator(".approval-row")).toHaveCount(1);
      const remote = path.join(root, "remote.git");
      git("clone", "--bare", repo, remote);
      git("remote", "add", "origin", remote);
      await openSettingsScreen(page);
      await page.getByRole("button", { name: "Repositories", exact: true }).click();
      await expect(
        page.getByRole("checkbox", { name: /Auto-remove merged worktrees/ }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: "General", exact: true }).click();
      const autoRemove = page.getByRole("checkbox", { name: "Auto-remove merged worktrees" });
      await expect(autoRemove).not.toBeChecked();
      await autoRemove.check();
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.desktop.setupState())).settings
              .autoRemoveMergedWorktrees,
        )
        .toBe(true);
      await assertAccessible(page);
      await page.keyboard.press("Escape");
      await expect(confirmation.locator(".approval-row")).toHaveCount(1);
      const automaticTree = await call(parent.controlToken, "create_worktree", {
        idempotencyKey: "auto-tree",
        branch: "auto-merged",
      });
      assert.equal(automaticTree.body.result.status, "succeeded");
      await call(parent.controlToken, "remove_worktree", {
        idempotencyKey: "auto-remove",
        worktreeId: automaticTree.body.result.resultId,
      });
      await expect
        .poll(
          async () =>
            (
              await call(parent.controlToken, "operation_status", {
                idempotencyKey: "auto-remove",
              })
            ).body.result.status,
        )
        .toBe("succeeded");
      assert.equal(
        String(git("worktree", "list", "--porcelain")).includes("refs/heads/auto-merged"),
        false,
      );
      assert.match(String(git("branch", "--list", "auto-merged")), /auto-merged/);
      await expect(confirmation.locator(".approval-row")).toHaveCount(1);
      assert.equal(
        (await call(parent.controlToken, "operation_status", { idempotencyKey: "remove-1" })).body
          .result.status,
        "pending_confirmation",
      );
      await expect(confirmation.getByRole("heading", { name: /auto-merged$/ })).not.toBeVisible();
      const dirtyAuto = await call(parent.controlToken, "create_worktree", {
        idempotencyKey: "auto-dirty-tree",
        branch: "auto-dirty",
      });
      const dirtyAutoTree = (
        await page.evaluate((repository) => window.desktop.worktrees(repository), repository)
      ).find((worktree) => worktree.branch === "auto-dirty");
      assert.ok(dirtyAutoTree);
      // Reviewers detach to inspect a PR head; ownership must survive it.
      git("-C", dirtyAutoTree.path, "checkout", "--detach", "HEAD");
      await writeFile(path.join(dirtyAutoTree.path, "untracked.txt"), "needs review");
      await call(parent.controlToken, "remove_worktree", {
        idempotencyKey: "auto-dirty-remove",
        worktreeId: dirtyAuto.body.result.resultId,
      });
      await expect(
        confirmation.getByRole("heading", { name: dirtyAutoTree.path, exact: true }),
      ).toBeVisible();
      await expect(confirmation.getByRole("list", { name: "Uncommitted changes" })).toContainText(
        "untracked.txt",
      );
      await expect(confirmation.getByRole("list", { name: "Uncommitted changes" })).toContainText(
        "untracked",
      );
      await clickApproval(
        confirmation,
        confirmation.getByRole("button", {
          name: "Discard 1 file and remove",
          exact: true,
        }),
      );
      await expect
        .poll(
          async () =>
            (
              await call(parent.controlToken, "operation_status", {
                idempotencyKey: "auto-dirty-remove",
              })
            ).body.result.status,
        )
        .toBe("succeeded");
      await openSettingsScreen(page);
      await page.getByRole("button", { name: "General", exact: true }).click();
      await expect(autoRemove).toBeChecked();
      await autoRemove.uncheck();
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.desktop.setupState())).settings
              .autoRemoveMergedWorktrees,
        )
        .toBe(false);
      await page.keyboard.press("Escape");
      // With the policy off, clean merged branches still join the review batch.
      const extraTrees = [];
      for (const branch of ["batch-selected", "batch-declined"]) {
        const created = await call(parent.controlToken, "create_worktree", {
          idempotencyKey: `create-${branch}`,
          branch,
        });
        assert.equal(created.body.result.status, "succeeded");
        extraTrees.push({ branch, id: created.body.result.resultId });
      }
      const dirtyTree = (
        await page.evaluate((repository) => window.desktop.worktrees(repository), repository)
      ).find((worktree) => worktree.branch === "batch-selected");
      assert.ok(dirtyTree);
      await writeFile(path.join(dirtyTree.path, "uncommitted.txt"), "discard only by named action");
      const removal = await call(parent.controlToken, "remove_worktree", {
        idempotencyKey: "remove-1",
        worktreeId: tree.body.result.resultId,
      });
      assert.equal(removal.body.result.status, "pending_confirmation");
      await expect(confirmation.getByRole("heading", { name: /child-one$/ })).toBeVisible();
      for (const tree of extraTrees) {
        const queued = await call(parent.controlToken, "remove_worktree", {
          idempotencyKey: `remove-${tree.branch}`,
          worktreeId: tree.id,
        });
        assert.equal(queued.body.result.status, "pending_confirmation");
      }
      await expect(confirmation.locator(".approval-row")).toHaveCount(3);
      const removalRow = (branch) =>
        confirmation
          .locator(".approval-row")
          .filter({ has: confirmation.getByRole("heading", { name: new RegExp(`${branch}$`) }) });
      await expect(removalRow("child-one")).toContainText("Clean");
      await assertAccessible(confirmation);
      await confirmation.screenshot({
        path: evidencePath(`batch-removal-${cliOnly ? "agy" : "claude"}.png`),
        animations: "disabled",
      });
      const { startQuitOrdering } = require("./quit-diagnostics.js");
      const ordering = startQuitOrdering(app);
      try {
        await ordering.install();
        await clickApproval(
          confirmation,
          removalRow("child-one").getByRole("button", { name: /^Approve ·/ }),
        );
        await clickApproval(
          confirmation,
          removalRow("batch-selected").getByRole("button", {
            name: "Discard 1 file and remove",
            exact: true,
          }),
        );
        await clickApproval(
          confirmation,
          removalRow("batch-declined").getByRole("button", { name: "Decline", exact: true }),
        );
        for (const tree of extraTrees) {
          await expect
            .poll(
              async () =>
                (
                  await call(parent.controlToken, "operation_status", {
                    idempotencyKey: `remove-${tree.branch}`,
                  })
                ).body.result.status,
            )
            .toBe(tree.branch === "batch-selected" ? "succeeded" : "declined");
        }
      } finally {
        ordering.stop();
        context.diagnostic(`Removal approval ordering: ${JSON.stringify(ordering.snapshot())}`);
      }

      assert.equal(
        String(git("worktree", "list", "--porcelain")).includes("refs/heads/batch-selected"),
        false,
      );
      assert.equal(
        String(git("worktree", "list", "--porcelain")).includes("refs/heads/batch-declined"),
        true,
      );

      await expect
        .poll(
          async () =>
            (await call(parent.controlToken, "operation_status", { idempotencyKey: "remove-1" }))
              .body.result.status,
        )
        .toBe("succeeded");
      assert.match(String(git("branch", "--list", "child-one")), /child-one/);

      // Exercise whole-batch decisions through the real control and Git removal paths.
      for (const approve of [true, false]) {
        const batch = [];
        for (const suffix of ["one", "two"]) {
          const branch = `batch-${approve ? "all" : "none"}-${suffix}`;
          const created = await call(parent.controlToken, "create_worktree", {
            idempotencyKey: `create-${branch}`,
            branch,
          });
          assert.equal(created.body.result.status, "succeeded");
          batch.push({ branch, id: created.body.result.resultId });
        }
        for (const tree of batch) {
          await call(parent.controlToken, "remove_worktree", {
            idempotencyKey: `remove-${tree.branch}`,
            worktreeId: tree.id,
          });
        }
        await expect(confirmation.locator(".approval-row")).toHaveCount(2);
        if (approve) {
          await clickApproval(
            confirmation,
            confirmation.getByRole("button", {
              name: "Approve all clean removals (2)",
              exact: true,
            }),
          );
        } else {
          for (const tree of batch)
            await clickApproval(
              confirmation,
              removalRow(tree.branch).getByRole("button", { name: "Decline", exact: true }),
            );
        }
        for (const tree of batch) {
          await expect
            .poll(
              async () =>
                (
                  await call(parent.controlToken, "operation_status", {
                    idempotencyKey: `remove-${tree.branch}`,
                  })
                ).body.result.status,
            )
            .toBe(approve ? "succeeded" : "declined");
          assert.equal(
            String(git("worktree", "list", "--porcelain")).includes(`refs/heads/${tree.branch}`),
            !approve,
          );
        }
      }

      await assert.rejects(
        page.evaluate(() =>
          window.desktop.actionLog({ search: "", action: "", status: "", offset: -1 }),
        ),
      );
      await assert.rejects(
        page.evaluate(() =>
          window.desktop.actionLog({
            search: "",
            action: "",
            status: "",
            offset: 0,
            path: "/secret",
          }),
        ),
      );
      await page.getByRole("button", { name: "Foom menu" }).click();
      await page.getByRole("menuitem", { name: "Developer", exact: true }).click();
      await page.getByRole("menuitem", { name: "Action log", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Action log" })).toBeVisible();
      const history = page.getByRole("region", { name: "Action history" });
      await expect(history.getByText("make orchestrator", { exact: true }).first()).toBeVisible();
      await page.getByRole("searchbox").fill("remove_worktree");
      await page.getByLabel("Outcome", { exact: true }).selectOption("succeeded");
      await expect(history.getByText("remove worktree", { exact: true })).toHaveCount(6);
      await page.screenshot({
        path: evidencePath(`action-log-${cliOnly ? "agy" : "claude"}.png`),
        animations: "disabled",
      });
      await assertAccessible(page);
      await page.getByRole("searchbox").press("Escape");
      await expect(page.getByRole("heading", { name: "Action log" })).toHaveCount(0);

      // Making the orchestrator again is a no-op without a dialog.
      await page.evaluate(
        (id) => window.desktop.sidebarCommand({ kind: "make-orchestrator", id }),
        parentId,
      );
      const orchestrators = (
        await page.evaluate(() => window.desktop.workspace())
      ).terminals.filter((row) => row.orchestration?.role === "orchestrator");
      assert.equal(orchestrators.length, 1);

      // Keep a live child when its parent is revoked and exits.
      const liveTree = await call(parent.controlToken, "create_worktree", {
        idempotencyKey: "tree-live",
        branch: "child-live",
      });
      assert.equal(liveTree.body.result.status, "succeeded");
      const liveLaunch = await call(parent.controlToken, "launch", {
        idempotencyKey: "launch-live",
        worktreeId: liveTree.body.result.resultId,
        agent: cliOnly ? "claude" : "codex",
      });
      assert.equal(liveLaunch.body.result.status, "succeeded");
      const liveId = liveLaunch.body.result.resultId;
      await expect(page.locator('.board-row .session-robot-mark[data-kind="rx"]')).toHaveCount(1);

      if (!cliOnly) {
        let previous = (await call(parent.controlToken, "session_state", { id: liveId })).body
          .result;
        for (const [key, label] of [
          ["@", "Provider unavailable"],
          ["#", "Provider rate limit"],
          ["$", "Model switch requested"],
        ]) {
          const waiting = call(parent.controlToken, "wait_for", {
            ids: [liveId],
            after: { [liveId]: previous.revision },
            timeoutMs: 30000,
          });
          await page.evaluate(({ id, key }) => window.desktop.input(id, key), { id: liveId, key });
          await expect
            .poll(
              async () =>
                (await call(parent.controlToken, "session_state", { id: liveId })).body.result
                  .reason,
            )
            .toBe("provider_unavailable");
          const stalled = (await call(parent.controlToken, "session_state", { id: liveId })).body
            .result;
          assert.equal(stalled.state, "needs_input");
          assert.equal(stalled.attentionKind, "provider");
          assert.notEqual(stalled.revision, previous.revision);
          // A wait may wake on input invalidation before classification; waiting again
          // from that revision must expose the same fixed stall metadata.
          const awakened = (await waiting).body.result.sessions[0];
          const observed =
            awakened.reason === "provider_unavailable"
              ? awakened
              : (
                  await call(parent.controlToken, "wait_for", {
                    ids: [liveId],
                    after: { [liveId]: awakened.revision },
                    timeoutMs: 30000,
                  })
                ).body.result.sessions[0];
          assert.equal(observed.reason, "provider_unavailable");
          assert.equal(observed.attentionKind, "provider");
          const answered = await call(parent.controlToken, "send_keys", {
            id: liveId,
            keys: ["esc"],
            idempotencyKey: `provider-keys-${key.codePointAt(0)}`,
          });
          assert.equal(answered.body.result.status, "succeeded");
          await expect(
            page.getByRole("treeitem", { name: new RegExp(`Needs you.*${label}`) }),
          ).toBeVisible();
          previous = stalled;
        }
      }

      // Revoke ends orchestration on the same credential; the session keeps running.
      await parentRow
        .locator(":scope > .board-row")
        .getByRole("button", { name: /^Actions for/ })
        .click();
      await page.getByRole("menuitem", { name: "Revoke orchestrator" }).click();
      await expect
        .poll(async () => (await call(parent.controlToken, "whoami")).body.result?.role)
        .toBe("agent");
      assert.equal(
        (await call(parent.controlToken, "tail", { id: childId, lines: 1 })).status,
        403,
      );

      const liveChild = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
        (row) => row.id === liveId,
      );
      assert.equal(liveChild.exited, false);
      await expect(page.getByText("Revoked orchestrator", { exact: true })).toBeVisible();
      await expect(page.locator('.board-row .session-robot-mark[data-kind="rx"]')).toHaveCount(1);
      const logged = await page.evaluate(() =>
        window.desktop.actionLog({
          search: "",
          action: "revoke_orchestrator",
          status: "succeeded",
          offset: 0,
        }),
      );
      assert.equal(logged.total, 1);
      // Re-grant visibly recovers this same running tile's previous live child.
      const regrant = page.evaluate(
        (id) => window.desktop.sidebarCommand({ kind: "make-orchestrator", id }),
        parentId,
      );
      const recovery = await approvalPage(app);
      await expect(recovery.getByText(/Re-granting this tile before Foom restarts/)).toBeVisible();
      await clickApproval(
        recovery,
        recovery.getByRole("button", { name: "Approve · Make orchestrator", exact: true }),
      );
      await regrant;
      assert.equal((await directCall(parent.controlToken, "tail", { id: liveId })).status, 200);
      assert.equal(
        (
          await directCall(parent.controlToken, "prompt", {
            id: liveId,
            text: "Continue",
            idempotencyKey: "regrant-prompt",
          })
        ).body.result.status,
        "succeeded",
      );
      assert.equal(
        (
          await directCall(parent.controlToken, "send_keys", {
            id: liveId,
            keys: ["enter"],
            idempotencyKey: "regrant-keys",
          })
        ).body.result.status,
        "succeeded",
      );
      await page.evaluate(
        (id) => window.desktop.sidebarCommand({ kind: "revoke-orchestrator", id }),
        parentId,
      );

      await page.evaluate(() => window.desktop.clearActionLog());
      assert.equal(
        (
          await page.evaluate(() =>
            window.desktop.actionLog({ search: "", action: "", status: "", offset: 0 }),
          )
        ).total,
        0,
      );

      // Exit revokes the credential itself; the snapshot keeps the history.
      await page.evaluate((id) => window.desktop.input(id, "q"), parentId);
      await expect.poll(async () => (await call(parent.controlToken, "whoami")).status).toBe(401);
      const after = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
        (row) => row.id === parentId,
      );
      assert.equal(after.orchestration.active, false);
      await expect(page.getByText("Exited orchestrator", { exact: true })).toBeVisible();
      await expect(page.locator('.board-row .session-robot-mark[data-kind="rx"]')).toHaveCount(1);
      const childCount = (await page.evaluate(() => window.desktop.workspace())).terminals.filter(
        (row) => row.orchestration?.role === "child" && row.orchestration.parentId === parentId,
      ).length;
      await parentRow
        .locator(":scope > .board-row")
        .getByRole("button", { name: /^Actions for/ })
        .click();
      await page.getByRole("menuitem", { name: "Close", exact: true }).click();
      const refusal = page.getByRole("alert");
      await expect(refusal).toContainText(
        `Close its ${childCount} ${childCount === 1 ? "child" : "children"} first.`,
      );
      if (!cliOnly) {
        for (const theme of ["eclipse-light", "eclipse-dark"]) {
          await page.evaluate(
            (interfaceTheme) => window.desktop.saveSetup({ interfaceTheme }),
            theme,
          );
          await page.screenshot({
            path: evidencePath(`975-close-refusal-${theme}.png`),
            animations: "disabled",
          });
        }
      }
      await page.getByRole("button", { name: "Dismiss", exact: true }).click();
      await assert.rejects(
        page.evaluate((id) => window.desktop.sidebarCommand({ kind: "close", id }), parentId),
        new RegExp(`foom-error:session-has-children:${childCount}`),
      );
      assert.ok(after.orchestration.history.some((entry) => entry.action === "remove_worktree"));
    }
  }

  // Attachment is per launch: nothing written to the user's agent config or the repository.
  const homeEntries = await readdir(home);
  for (const name of [".claude", ".claude.json", ".codex", ".gemini"])
    assert.ok(!homeEntries.includes(name), `${name} was written`);
  const repoEntries = await readdir(repo);
  for (const name of [".mcp.json", ".claude", ".codex"])
    assert.ok(!repoEntries.includes(name), `${name} was written to the repository`);
}

module.exports = { runOrchestratorScenario };
