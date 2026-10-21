const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { gitSync: isolatedGit } = require("../helpers/git.js");
const { FAKE_GH } = require("../helpers/forge-cli.js");
const { deadline, expect } = require("./test-policy.js");
const {
  FAKE_ORCHESTRATED_CLAUDE,
  boardPage,
  confirmationPage,
  launchApp,
  removeAfterApps,
  assertAccessible,
} = require("./harness.js");

// Each child waits on a fixture-owned file outside the checkout. No terminal input
// drives the loop. Launch/resume argv, handoffs, hooks and process exits drive it.
const REVIEW_AGENT = FAKE_ORCHESTRATED_CLAUDE.replace(
  'const isChild = path.basename(process.cwd()).startsWith("child-");',
  `const isChild = path.basename(process.cwd()).startsWith("child-");
if (isChild) {
  const fs = require("node:fs");
  const reviewer = args.some(arg => arg.includes("Review PR #340"));
  const resumed = args.includes("--resume");
  const step = reviewer ? (fs.existsSync(path.join(process.env.TEST_REVIEW_ROOT, "review-1.finished")) ? "review-2" : "review-1") : resumed ? "fix" : "build";
  record(step, JSON.stringify({ args, controlUrl: process.env.FOOM_CONTROL_URL, controlToken: process.env.FOOM_CONTROL_TOKEN, instanceId: process.env.FOOM_CONTROL_INSTANCE }));
  process.stdin.on("data", () => { record("unexpected-input", "PTY input received"); process.exit(2); });
  const timer = setInterval(async () => {
    const file = path.join(process.env.TEST_REVIEW_ROOT, step + ".go");
    if (!fs.existsSync(file)) return;
    clearInterval(timer);
    const command = JSON.parse(fs.readFileSync(file, "utf8"));
    const hook = await fetch(process.env.FOOM_HOOK_URL, { method: "POST", headers: { Authorization: process.env.FOOM_TOKEN, "X-Foom-Session": process.env.FOOM_SESSION, "X-Foom-Event": "Stop", "X-Foom-Sequence": "1", "Content-Type": "application/json" }, body: JSON.stringify({ session_id: reviewer ? "review-" + step : "author-conversation", hook_event_name: "Stop" }) });
    if (hook.status !== 204) { record("hook-error", String(hook.status)); process.exit(2); }
    const send = () => fetch(process.env.FOOM_CONTROL_URL, { method: "POST", headers: { Authorization: "Bearer " + process.env.FOOM_CONTROL_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, instanceId: process.env.FOOM_CONTROL_INSTANCE, method: "handoff", params: { status: command.status ?? "done", summary: "Fixture " + step, idempotencyKey: step, ...(command.review ? { review: command.review } : {}) } }) });
    let response;
    for (let attempt = 0; attempt < 12; attempt++) {
      response = await send();
      if (response.status === 200) break;
      const body = await response.json();
      if (body.error !== "capacity") break;
      // The same author ID retains the existing one-report-per-ten-second limit.
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (response.status !== 200) { record("handoff-error", String(response.status)); process.exit(2); }
    if (command.edit) fs.writeFileSync("reviewer-edit.txt", "must escalate");
    fs.writeFileSync(path.join(process.env.TEST_REVIEW_ROOT, step + ".finished"), "finished");
    process.exit(0);
  }, 50);
  return;
}`,
);

for (const scenario of ["clean", "fix", "cap", "edit", "blocked", "red"]) {
  test("owned child review loop: " + scenario, {
    timeout: deadline(90000),
    skip: process.platform === "win32" && "The fake agent is a POSIX script",
  }, async (context) => {
    const { chmod, mkdir, readFile, symlink, writeFile } = require("node:fs/promises");
    const { existsSync } = require("node:fs");
    const root = await mkdtemp(path.join(tmpdir(), "foom-forge-adopt-"));
    removeAfterApps(context, root);
    const bin = path.join(root, "bin");
    const repo = path.join(root, "app");
    const home = path.join(root, "home");
    for (const directory of [bin, repo, home]) await mkdir(directory);
    await writeFile(path.join(bin, "claude"), REVIEW_AGENT);
    await writeFile(path.join(bin, "gh"), FAKE_GH);
    for (const name of ["claude", "gh"]) await chmod(path.join(bin, name), 0o755);
    await symlink(process.execPath, path.join(bin, "node"));
    const git = (...args) =>
      isolatedGit(["-c", "user.name=Foom", "-c", "user.email=foom@example.com", ...args], {
        cwd: repo,
        encoding: "utf8",
      });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const headSha = git("rev-parse", "HEAD").trim();
    git("branch", "child-one");
    const remote = path.join(root, "remote.git");
    git("clone", "--bare", repo, remote);
    git("branch", "-D", "child-one");
    git("remote", "add", "origin", "https://github.com/fixture/offline.git");
    git("config", `url.${remote}.insteadOf`, "https://github.com/fixture/offline.git");
    git("config", "remote.pushDefault", "elsewhere");
    const forgeState = path.join(root, "forge.json");
    await writeFile(
      forgeState,
      JSON.stringify({
        pr: { headRepositoryOwner: { login: "fixture" }, headRefOid: headSha },
        checks: [{ bucket: scenario === "red" ? "fail" : "pass" }],
      }),
    );
    const credentials = path.join(root, "credentials.json");
    const app = await launchApp(context, {
      fixture: "agent",
      args: [`--user-data-dir=${path.join(root, "user-data")}`],
      env: {
        HOME: home,
        // Git and the fixed POSIX hook adapter require these system tool directories.
        PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter),
        TEST_FAKE_CREDENTIALS: credentials,
        TEST_FORGE_STATE: forgeState,
        TEST_REVIEW_ROOT: root,
      },
    });
    const page = await boardPage(app);
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, repo);
    const repository = await page.evaluate(async () => (await window.desktop.addRepository()).path);
    await page.evaluate(
      ({ repository }) =>
        window.desktop.sidebarCommand({
          kind: "launch",
          repository,
          worktree: repository,
          run: "claude",
        }),
      { repository },
    );
    await expect.poll(() => existsSync(`${credentials}.app`)).toBe(true);
    const parent = JSON.parse(await readFile(`${credentials}.app`, "utf8"));
    const call = async (method, params = {}) => {
      const response = await fetch(parent.controlUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${parent.controlToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ version: 1, instanceId: parent.instanceId, method, params }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    const parentId = (await call("whoami")).terminalId;
    const parentRow = page
      .locator(".session-entry")
      .filter({ has: page.locator(`[data-drag-session="${parentId}"]`) });
    await parentRow
      .locator(":scope > .board-row")
      .getByRole("button", { name: /^Actions for/ })
      .click();
    await page.getByRole("menuitem", { name: "Make orchestrator…" }).click();
    const confirmation = await confirmationPage(app);
    await expect(
      confirmation.getByText(/Close its exited children, discarding their final screens/),
    ).toBeVisible();
    await confirmation.getByRole("button", { name: "Make orchestrator" }).click();
    await expect.poll(async () => (await call("whoami")).role).toBe("orchestrator");

    const tree = await call("create_worktree", { pullRequest: 340, idempotencyKey: "tree" });
    const result = await call("launch", {
      worktreeId: tree.resultId,
      agent: "claude",
      prompt: "Fixture task",
      review: { rounds: scenario === "cap" ? 1 : 3 },
      idempotencyKey: "author",
    });
    assert.equal(result.status, "succeeded");
    const authorId = result.resultId;
    const row = page.locator(`[data-drag-session="${authorId}"]`);
    const state = async () => (await call("session_state", { id: authorId })).review;
    const shot = async (name) => {
      await page.screenshot({ path: `test-results/review-loop-${scenario}-${name}.png` });
    };
    await expect(row.locator('[data-review-phase="building"]')).toHaveText("Building");
    await shot("building");
    await expect.poll(() => existsSync(`${credentials}.build`)).toBe(true);
    await expect
      .poll(
        async () => (await call("session_state", { id: authorId })).pullRequest?.requiredChecks,
        { timeout: deadline(15000) },
      )
      .toBe(scenario === "red" ? "failure" : "success");
    const go = (step, command = {}) =>
      writeFile(path.join(root, step + ".go"), JSON.stringify(command));
    await go("build", scenario === "blocked" ? { status: "blocked" } : {});
    if (["blocked", "red"].includes(scenario)) {
      await expect.poll(async () => (await state())?.phase).toBe("escalated");
      assert.equal(
        (await state()).reason,
        scenario === "blocked" ? "author blocked" : "checks not green",
      );
      assert.equal(existsSync(`${credentials}.review-1`), false);
    } else {
      await expect.poll(() => existsSync(`${credentials}.review-1`)).toBe(true);
      await expect(row.locator('[data-review-phase="reviewing"]')).toContainText("Reviewing 1/");
      await shot("reviewing");
      const findings = {
        verdict: "findings",
        findings: [
          { file: "a.ts", line: 1, summary: "Incorrect zero result", scenario: "Call with zero" },
        ],
      };
      await go("review-1", {
        review: ["fix", "cap"].includes(scenario) ? findings : { verdict: "clean" },
        edit: scenario === "edit",
      });
      if (scenario === "fix") {
        await expect.poll(() => existsSync(`${credentials}.fix`)).toBe(true);
        await expect(row.locator('[data-review-phase="fixing"]')).toContainText("Fixing 1/3");
        await shot("fixing");
        const resumed = JSON.parse(await readFile(`${credentials}.fix`, "utf8"));
        assert.equal(resumed.args[resumed.args.indexOf("--resume") + 1], "author-conversation");
        assert.ok(resumed.args.at(-1).includes("Quoted review notes (JSON)"));
        await go("fix");
        await expect.poll(() => existsSync(`${credentials}.review-2`)).toBe(true);
        await go("review-2", { review: { verdict: "clean" } });
      }
      await expect
        .poll(async () => (await state())?.phase)
        .toBe(["edit", "cap"].includes(scenario) ? "escalated" : "clean");
      if (scenario === "edit") assert.equal((await state()).reason, "worktree changed");
      if (scenario === "cap") assert.equal((await state()).reason, "round cap");
    }
    await shot("finished");
    assert.equal(existsSync(`${credentials}.unexpected-input`), false);
    await assertAccessible(page);
  });
}
