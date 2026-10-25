// Manual Linux profiling recipe; deliberately not discovered as a feature suite.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtemp, mkdir, writeFile, chmod, symlink, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { setTimeout: sleep } = require("node:timers/promises");
const { gitSync } = require("../helpers/git.js");
const {
  FAKE_ORCHESTRATED_CLAUDE,
  launchApp,
  boardPage,
  confirmationPage,
  removeAfterApps,
} = require("./harness.js");
const { expect } = require("./test-policy.js");

const captureMs = 120_000;
test("profile ten owned fixture children", { timeout: 240_000 }, async (context) => {
  assert.equal(process.platform, "linux", "Recipe uses Linux/Xvfb");
  const evidence = path.resolve(process.env.FOOM_CPU_EVIDENCE ?? "test-results/main-cpu");
  await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(path.join(tmpdir(), "foom-cpu-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "app");
  const home = path.join(root, "home");
  const profile = path.join(root, "profile");
  await Promise.all([bin, repo, home, profile].map((dir) => mkdir(dir)));
  await writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      version: 1,
      settings: { setupComplete: true, checkForUpdates: false, concurrentChildren: 10 },
    }),
  );
  // One line every two seconds; a 128 KiB burst every 30s. Backpressure is
  // respected and every write is followed by sleep. No real agent or forge CLI.
  const source =
    FAKE_ORCHESTRATED_CLAUDE +
    `
if (isChild) {
  let tick = 0;
  const emit = () => {
    tick++;
    const text = tick % 15 === 0
      ? ("fixture build output " + "x".repeat(100) + "\\r\\n").repeat(1024)
      : "fixture progress " + tick + "\\r\\n";
    const next = () => setTimeout(emit, 2000);
    if (process.stdout.write(text)) next();
    else process.stdout.once("drain", next);
  };
  setTimeout(emit, 2000);
}
`;
  await writeFile(path.join(bin, "claude"), source);
  await chmod(path.join(bin, "claude"), 0o755);
  await symlink(process.execPath, path.join(bin, "node"));
  gitSync(["init", "-q", "-b", "main"], { cwd: repo });
  gitSync(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ],
    { cwd: repo },
  );
  const credentials = path.join(root, "credentials");
  const app = await launchApp(context, {
    fixture: "agent",
    profileCaptureMs: captureMs,
    args: [`--user-data-dir=${profile}`],
    env: { HOME: home, PATH: bin, TEST_FAKE_CREDENTIALS: credentials },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, repo);
  const repository = await page.evaluate(async () => (await window.desktop.addRepository()).path);
  await page.evaluate(
    (repository) =>
      window.desktop.sidebarCommand({
        kind: "launch",
        repository,
        worktree: repository,
        run: "claude",
      }),
    repository,
  );
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(`${credentials}.app`, "utf8"));
      } catch {
        return null;
      }
    })
    .toBeTruthy();
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
    assert.equal(response.status, 200, `${method} HTTP status`);
    const body = await response.json();
    assert.ok(body.result, JSON.stringify(body));
    return body.result;
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
  await confirmation.getByRole("button", { name: "Make orchestrator", exact: true }).click();
  await expect.poll(async () => (await call("whoami")).role).toBe("orchestrator");
  // inspector.Session profiles V8 in the MAIN process, not renderer CDP.
  await app.evaluate(async () => {
    const { Session } = process.getBuiltinModule("inspector");
    const session = new Session();
    session.connect();
    globalThis.cpuCapture = {
      session,
      post: (method) =>
        new Promise((resolve, reject) =>
          session.post(method, (error, result) => (error ? reject(error) : resolve(result))),
        ),
    };
    await globalThis.cpuCapture.post("Profiler.enable");
    await globalThis.cpuCapture.post("Profiler.start");
    globalThis.cpuCapture.started = Date.now();
  });
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const tree = await call("create_worktree", {
      branch: `child-${i}`,
      idempotencyKey: `tree-${i}`,
    });
    assert.equal(tree.status, "succeeded");
    const launch = await call("launch", {
      worktreeId: tree.resultId,
      agent: "claude",
      idempotencyKey: `launch-${i}`,
    });
    assert.equal(launch.status, "succeeded");
    ids.push(launch.resultId);
  }
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.workspace())).terminals.filter(
          (row) => ids.includes(row.id) && row.outputRevision > 0 && !row.exited,
        ).length,
    )
    .toBe(10);
  await app.evaluate(() => {
    globalThis.cpuCapture.steady = {
      cpu: process.cpuUsage(),
      time: process.hrtime.bigint(),
      started: Date.now(),
    };
  });
  console.log("Ten children ready; capturing 120s steady output and polling");
  const end = Date.now() + captureMs;
  let polls = 0;
  while (Date.now() < end) {
    const sessions = (await call("sessions", { limit: 100 })).sessions;
    const after = Object.fromEntries(
      sessions.filter((row) => ids.includes(row.id)).map((row) => [row.id, row.revision]),
    );
    await call("wait_for", { ids, after, timeoutMs: 1000 });
    polls++;
    await sleep(Math.min(1000, Math.max(0, end - Date.now())));
  }
  const metrics = await app.evaluate(async (_electron, evidence) => {
    const capture = globalThis.cpuCapture;
    const cpu = process.cpuUsage(capture.steady.cpu);
    const wallMs = Number(process.hrtime.bigint() - capture.steady.time) / 1e6;
    const { profile } = await capture.post("Profiler.stop");
    capture.session.disconnect();
    process
      .getBuiltinModule("fs")
      .writeFileSync(
        process.getBuiltinModule("path").join(evidence, "main.cpuprofile"),
        JSON.stringify(profile),
      );
    return {
      cpu,
      wallMs,
      cpuPercent: (cpu.user + cpu.system) / (wallMs * 10),
      captureStarted: capture.started,
      steadyStarted: capture.steady.started,
      ended: Date.now(),
      pid: process.pid,
    };
  }, evidence);
  await writeFile(
    path.join(evidence, "metrics.json"),
    JSON.stringify({ ...metrics, polls, children: ids.length }, null, 2),
  );
  console.log(JSON.stringify(metrics));
});
