const { launchTrustedParent } = require("./agent-fixture.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { gitSync: isolatedGit } = require("../helpers/git.js");
const { FAKE_GH } = require("../helpers/forge-cli.js");
const { deadline, expect } = require("./test-policy.js");
const { waitForFixtureRecord } = require("./fixture-records.js");
const {
  FAKE_ORCHESTRATED_CLAUDE,
  boardPage,
  confirmationPage,
  launchApp,
  quitAndWait,
  removeAfterApps,
  assertAccessible,
} = require("./harness.js");

// Each child waits on a fixture-owned file outside the checkout. No terminal input
// drives the loop. Launch/resume argv, handoffs, hooks and process exits drive it.
const REVIEW_AGENT =
  FAKE_ORCHESTRATED_CLAUDE.replace(
    'const isChild = path.basename(process.cwd()).startsWith("child-");',
    `const isChild = path.basename(process.cwd()).startsWith("child-");
if (isChild) {
  const fs = require("node:fs");
  const reviewer = args.some(arg => arg.includes("Review PR #340"));
  const resumed = args.includes("--resume");
  const step = reviewer ? (fs.existsSync(path.join(process.env.TEST_REVIEW_ROOT, "review-1.finished")) ? "review-2" : "review-1") : resumed ? "fix" : "build";
  record(step, JSON.stringify({ args, controlUrl: process.env.FOOM_CONTROL_URL, controlToken: process.env.FOOM_CONTROL_TOKEN, instanceId: process.env.FOOM_CONTROL_INSTANCE }));
  let parentReplied = false;
  process.stdin.on("data", () => {
    if (process.env.TEST_REVIEW_BLOCK === "1" && step === "build") {
      parentReplied = true;
      record("parent-replied", "received");
    } else { record("unexpected-input", "PTY input received"); process.exit(2); }
  });
  const fixtureError = error => { record("fixture-error", error instanceof Error ? error.message : String(error)); process.exit(2); };
  process.on("uncaughtException", fixtureError);
  process.on("unhandledRejection", fixtureError);
  if (process.env.TEST_REVIEW_OUTPUT === "1") {
    let bytes = 0;
    let draining = false;
    setInterval(() => {
      if (draining) return;
      const chunk = "Fixture output line\\r\\n".repeat(1024);
      bytes += Buffer.byteLength(chunk);
      if (!process.stdout.write(chunk)) { draining = true; process.stdout.once("drain", () => { draining = false; }); }
      record("output-" + path.basename(process.cwd()), String(bytes));
    }, 20);
  }
  const timer = setInterval(async () => {
    const file = path.join(process.env.TEST_REVIEW_ROOT, step + ".go");
    if (!fs.existsSync(file)) return;
    clearInterval(timer);
    const command = JSON.parse(fs.readFileSync(file, "utf8"));
    const hook = await fetch(process.env.FOOM_HOOK_URL, { method: "POST", headers: { Authorization: process.env.FOOM_TOKEN, "X-Foom-Session": process.env.FOOM_SESSION, "X-Foom-Event": "Stop", "X-Foom-Channel": "lifecycle", "X-Foom-Sequence": "1", "Content-Type": "application/json" }, body: JSON.stringify({ session_id: reviewer ? "review-" + step : "author-conversation", hook_event_name: "Stop" }) });
    if (hook.status !== 204) { record("hook-error", String(hook.status)); process.exit(2); }
    if (command.edit) fs.writeFileSync("reviewer-edit.txt", "must escalate");
    fs.writeFileSync(path.join(process.env.TEST_REVIEW_ROOT, step + ".finished"), "finished");
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
    if (command.status === "blocked") {
      const blockedAt = Date.now();
      const resumeTimer = setInterval(async () => {
        if (!parentReplied || !fs.existsSync(path.join(process.env.TEST_REVIEW_ROOT, "resume.go"))) return;
        clearInterval(resumeTimer);
        // Reuse the bounded handoff interval; never bypass production rate limits.
        await new Promise(resolve => setTimeout(resolve, Math.max(0, 10000 - (Date.now() - blockedAt))));
        record("unblocked", "done");
        const response = await fetch(process.env.FOOM_CONTROL_URL, { method: "POST", headers: { Authorization: "Bearer " + process.env.FOOM_CONTROL_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, instanceId: process.env.FOOM_CONTROL_INSTANCE, method: "handoff", params: { status: "done", summary: "Unblocked fixture build", idempotencyKey: "unblocked" } }) });
        if (response.status !== 200) { record("handoff-error", String(response.status)); process.exit(2); }
        // Remain interactive until the host stops the session.
      }, 50);
    }
    // Successful handoffs never exit this fixture; Foom owns termination.
  }, 50);
  return;
}`,
  ) +
  `
if (process.env.TEST_REVIEW_OUTPUT === "1") {
  fetch(process.env.FOOM_HOOK_URL, { method: "POST", headers: { Authorization: process.env.FOOM_TOKEN, "X-Foom-Session": process.env.FOOM_SESSION, "X-Foom-Event": "Stop", "X-Foom-Channel": "lifecycle", "X-Foom-Sequence": "1", "Content-Type": "application/json" }, body: JSON.stringify({session_id: "parent-conversation", hook_event_name: "Stop"}) }).catch(error => { throw error; });
}
`;

for (const scenario of ["clean", "fix", "cap", "edit", "blocked", "red", "concurrent"]) {
  test("owned child review loop: " + scenario, {
    timeout: deadline(90000),
    skip: process.platform === "win32" && "The fake agent is a POSIX script",
  }, async (context) => {
    const { chmod, mkdir, readFile, rename, symlink, writeFile } = require("node:fs/promises");
    const { existsSync } = require("node:fs");
    const root = await mkdtemp(
      scenario === "concurrent"
        ? path.resolve("test-results/foom-review-concurrent-")
        : path.join(tmpdir(), "foom-forge-adopt-"),
    );
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
    const options = {
      fixture: "agent",
      args: [`--user-data-dir=${path.join(root, "user-data")}`],
      env: {
        HOME: home,
        // Git and the fixed POSIX hook adapter require these system tool directories.
        PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter),
        TEST_FAKE_CREDENTIALS: credentials,
        TEST_FORGE_STATE: forgeState,
        TEST_REVIEW_ROOT: root,
        TEST_REVIEW_BLOCK: scenario === "blocked" ? "1" : "0",
        TEST_REVIEW_OUTPUT: scenario === "concurrent" ? "1" : "0",
      },
    };
    const {
      app,
      page,
      parent: initialParent,
    } = await launchTrustedParent(context, {
      repo,
      credentials,
      options: options,
    });
    let parent = initialParent;
    const call = async (method, params = {}) => {
      const response = await fetch(parent.controlUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${parent.controlToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ version: 1, instanceId: parent.instanceId, method, params }),
        // Worktree creation and launch include Git, persistence and startup.
        // Await completion under the case deadline; reads/input retain their
        // short responsiveness bound as well as cancellation with the case.
        signal:
          method === "create_worktree" || method === "launch"
            ? context.signal
            : AbortSignal.any([context.signal, AbortSignal.timeout(deadline(5000))]),
      });
      assert.equal(response.status, 200, `Control request ${method}`);
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

    if (scenario === "concurrent") {
      const rows = (current) =>
        current.evaluate(async () => (await window.desktop.workspace()).terminals);
      const ids = [result.resultId];
      const launchMore = async (generation) => {
        for (const index of [2, 3]) {
          const tree = await call("create_worktree", {
            branch: `child-${generation}-${index}`,
            idempotencyKey: `tree-${generation}-${index}`,
          });
          const child = await call("launch", {
            worktreeId: tree.resultId,
            agent: "claude",
            review: { rounds: 3 },
            idempotencyKey: `author-${generation}-${index}`,
          });
          assert.equal(child.status, "succeeded");
          ids.push(child.resultId);
        }
      };
      await launchMore("initial");
      await expect
        .poll(
          async () =>
            (await rows(page)).filter(
              (row) => ids.includes(row.id) && row.review?.phase === "building",
            ).length,
        )
        .toBe(3);
      await expect
        .poll(async () => (await rows(page)).find((row) => row.id === parentId)?.conversationId)
        .toBe("parent-conversation");
      const roundTrips = async () => {
        for (let index = 0; index < 10; index++) {
          const start = performance.now();
          assert.equal((await call("whoami")).role, "orchestrator");
          assert.ok(performance.now() - start < deadline(5000));
        }
      };
      await expect
        .poll(async () => {
          const files = (await require("node:fs/promises").readdir(root)).filter(
            (name) => name.startsWith("credentials.json.output-") && !name.endsWith(".tmp"),
          );
          const sizes = await Promise.all(
            files.map(async (file) => Number(await readFile(path.join(root, file), "utf8"))),
          );
          return sizes.filter((size) => size >= 1024 * 1024).length;
        })
        .toBe(3);
      await roundTrips();
      await quitAndWait(app, async () => {
        await app.evaluate(({ app }) => app.quit());
        await (await confirmationPage(app))
          .getByRole("button", { name: "Stop all and quit" })
          .click();
      });
      const restored = await launchApp(context, { ...options, fixture: "restored" });
      const restoredPage = await boardPage(restored);
      await expect
        .poll(
          async () =>
            (await rows(restoredPage)).filter(
              (row) =>
                ids.includes(row.id) &&
                row.dormant &&
                row.review?.phase === "escalated" &&
                row.review.reason === "restored",
            ).length,
        )
        .toBe(3);
      await expect
        .poll(
          async () =>
            JSON.parse(await readFile(`${credentials}.app`, "utf8")).controlToken !==
            parent.controlToken,
        )
        .toBe(true);
      parent = JSON.parse(await readFile(`${credentials}.app`, "utf8"));
      await roundTrips();
      // Two new active loops beside the three restored/escalated loops must
      // also settle without resurrecting dormant automation.
      await launchMore("restored");
      await roundTrips();
      assert.equal(
        (await rows(restoredPage)).filter(
          (row) =>
            ids.slice(0, 3).includes(row.id) && row.dormant && row.review?.reason === "restored",
        ).length,
        3,
      );
      return;
    }
    const authorId = result.resultId;
    const row = page.locator(`[data-drag-session="${authorId}"]`);
    const state = async () => (await call("session_state", { id: authorId })).review;
    const fixtureErrors = async () => {
      const errors = [];
      for (const suffix of ["hook-error", "handoff-error", "fixture-error", "unexpected-input"]) {
        const file = `${credentials}.${suffix}`;
        if (existsSync(file)) errors.push(`${suffix}: ${await readFile(file, "utf8")}`);
      }
      return errors;
    };
    const waitStep = (step) =>
      waitForFixtureRecord(
        `${credentials}.${step}`,
        ["hook-error", "handoff-error", "fixture-error", "unexpected-input"].map(
          (suffix) => `${credentials}.${suffix}`,
        ),
        context.signal,
      );
    const shot = async (name) => {
      await page.screenshot({ path: `test-results/review-loop-${scenario}-${name}.png` });
    };
    await expect(row.locator('[data-review-phase="building"]')).toHaveText("Building");
    await shot("building");
    await waitStep("build");
    await expect
      .poll(
        async () => (await call("session_state", { id: authorId })).pullRequest?.requiredChecks,
        { timeout: deadline(15000) },
      )
      .toBe(scenario === "red" ? "failure" : "success");
    const go = async (step, command = {}) => {
      const file = path.join(root, step + ".go");
      await writeFile(file + ".tmp", JSON.stringify(command));
      await rename(file + ".tmp", file);
    };
    await go("build", scenario === "blocked" ? { status: "blocked" } : {});
    if (scenario === "blocked") {
      await expect.poll(async () => (await state())?.phase).toBe("waiting-on-parent");
      await expect(row.locator('[data-review-phase="waiting-on-parent"]')).toHaveText(
        "Waiting on parent",
      );
      assert.notEqual((await call("session_state", { id: authorId })).state, "exited");
      await shot("waiting-on-parent");
      await call("prompt", {
        id: authorId,
        text: "Proceed within the existing scope",
        idempotencyKey: "unblock",
      });
      await expect.poll(async () => (await state())?.phase).toBe("building");
      await expect.poll(() => existsSync(`${credentials}.parent-replied`)).toBe(true);
      await go("resume");
      await waitStep("unblocked");
    }
    if (scenario === "red") {
      await expect.poll(async () => (await state())?.phase).toBe("escalated");
      assert.deepEqual(await fixtureErrors(), []);
      assert.equal((await state()).reason, "checks not green");
      assert.notEqual((await call("session_state", { id: authorId })).state, "exited");
      assert.equal(existsSync(`${credentials}.review-1`), false);
    } else {
      await waitStep("review-1");
      await expect(row.locator('[data-review-phase="reviewing"]')).toHaveText(
        `Reviewing 1/${scenario === "cap" ? 1 : 3}`,
      );
      await shot("reviewing");
      if (scenario === "clean") {
        const reviewer = page.locator(".session-entry").filter({
          has: page.locator('.session-robot-mark[data-kind="review"]'),
        });
        await expect(reviewer.getByRole("img", { name: "Reviewer" })).toBeVisible();
        await expect(reviewer.locator('[data-review-phase="reviewing"]')).toHaveText(
          "Reviewing 1/3",
        );
        await expect(row.locator('.session-robot-mark[data-kind="rx"]')).toBeVisible();
        await reviewer.locator(":scope > .board-row").click();
        const tile = page.locator(".terminal-tile").filter({
          has: page.getByRole("img", { name: "Reviewer" }),
        });
        await expect(tile.locator('[data-review-phase="reviewing"]')).toHaveText("Reviewing 1/3");
        await parentRow.locator(":scope > .board-row").hover();
        const wave = reviewer.locator(".robot-wave-inner");
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await expect
          .poll(() => wave.evaluate((node) => getComputedStyle(node).animationName))
          .toBe("robot-receive");
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expect
          .poll(() => wave.evaluate((node) => getComputedStyle(node).animationName))
          .toBe("none");
        await page.mouse.move(1, 1);
        for (const [colorScheme, fill] of [
          ["light", "rgb(243, 240, 250)"],
          ["dark", "rgb(5, 4, 10)"],
        ]) {
          await page.emulateMedia({ colorScheme });
          await expect
            .poll(() =>
              reviewer.locator(".robot-lens").evaluate((node) => getComputedStyle(node).fill),
            )
            .toBe(fill);
          await reviewer.screenshot({
            path: `test-results/reviewer-mark-${colorScheme}-sidebar.png`,
          });
          await tile
            .locator(".tile-title")
            .screenshot({ path: `test-results/reviewer-mark-${colorScheme}-tile.png` });
        }
        await page.emulateMedia({ colorScheme: null, reducedMotion: null });
      }

      const findings = {
        verdict: "findings",
        findings: [
          { file: "a.ts", line: 1, summary: "Incorrect zero result", scenario: "Call with zero" },
        ],
      };
      if (["clean", "fix", "cap"].includes(scenario)) {
        // The exited author remains visible while its reviewer can still find bugs.
        assert.equal((await call("session_state", { id: authorId })).state, "exited");
        await expect(row).toBeVisible();
      }
      await go("review-1", {
        review: ["fix", "cap"].includes(scenario) ? findings : { verdict: "clean" },
        edit: scenario === "edit",
      });
      if (scenario === "fix") {
        await waitStep("fix");
        await expect(row.locator('[data-review-phase="fixing"]')).toHaveText("Fixing 1/3");
        await shot("fixing");
        const resumed = JSON.parse(await readFile(`${credentials}.fix`, "utf8"));
        assert.equal(resumed.args[resumed.args.indexOf("--resume") + 1], "author-conversation");
        assert.ok(resumed.args.at(-1).includes("Quoted review notes (JSON)"));
        await go("fix");
        await waitStep("review-2");
        await expect(row.locator('[data-review-phase="reviewing"]')).toHaveText("Reviewing 2/3");
        await shot("reviewing-2");
        assert.equal((await call("session_state", { id: authorId })).state, "exited");
        await go("review-2", { review: { verdict: "clean" } });
      }
      await expect
        .poll(async () => (await state())?.phase)
        .toBe(["edit", "cap"].includes(scenario) ? "escalated" : "clean");
      if (scenario === "edit") assert.equal((await state()).reason, "worktree changed");
      if (scenario === "cap") assert.equal((await state()).reason, "round cap");
    }
    if (scenario === "clean") {
      await expect(page.locator('.session-robot-mark[data-kind="review"]')).toHaveCount(0);
      await writeFile(
        forgeState,
        JSON.stringify({
          pr: { headRefOid: headSha, state: "MERGED" },
          checks: [{ bucket: "pass" }],
        }),
      );
      // Reuse the existing tracker setting invalidation; no test-only main API.
      await page.evaluate(() => window.desktop.saveSetup({ showPullRequests: true }));
      await expect
        .poll(async () => (await call("session_state", { id: authorId })).pullRequest?.state, {
          timeout: deadline(60000),
        })
        .toBe("MERGED");
      await expect(row).toBeVisible();
      assert.equal((await state()).phase, "clean");
      await call("read_handoff", { id: authorId });
      await expect(row).toBeVisible();
      assert.equal((await state()).phase, "clean");
      assert.ok(git("worktree", "list", "--porcelain").includes("child-one"));
      assert.equal(git("rev-parse", "--verify", "child-one").trim(), headSha);
    }
    await shot("finished");
    assert.deepEqual(await fixtureErrors(), []);
    await assertAccessible(page);
  });
}
