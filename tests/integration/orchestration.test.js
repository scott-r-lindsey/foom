const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { mkdtemp, mkdir, writeFile, readFile, rm } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { git, gitEnvironment } = require("../helpers/git.js");
const {
  guardAgentProbes,
  assertFixtureAgent,
  isolatedEnvironment,
} = require("../electron/agent-isolation.js");
const { fixtureSea } = require("../electron/fixture-sea.js");
const { deadline } = require("../electron/test-policy.js");
const run = promisify(execFile);
assert.throws(() => require("electron"), /Electron must never load/);
assert.throws(() => require("electron/main"), /Electron must never load/);
const output = path.resolve("test-results/node-integration");

// Same core assertions as the retained Electron child-handoff scenario. No UI substitute.
test("real Node: owned child worktree and pull-only CLI handoff", {
  timeout: deadline(90000),
}, async (context) => {
  const started = performance.now();
  let bodyStart = started;
  let setupMs = 0;
  const root = await mkdtemp(path.join(os.tmpdir(), "foom-node-integration-"));
  let workspace;
  let terminals;
  const events = [];
  const failures = [];
  const inputs = [];
  const pids = [];
  const home = path.join(root, "home");
  const repo = path.join(root, "app");
  const profile = path.join(root, "profile");
  const bin = path.join(root, "agents");
  context.after(async () => {
    const teardown = performance.now();
    try {
      try {
        await terminals?.shutdown();
        await Promise.all(events);
      } finally {
        await workspace?.dispose();
      }
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      assert.deepEqual(failures, []);
      assert.equal(existsSync(path.join(profile, "control/discovery.json")), false);
      assert.equal(existsSync(path.join(root, "guard.log")), false);
    } finally {
      await rm(root, { recursive: true, force: true });
      context.diagnostic(
        `Node fixture timing: ${JSON.stringify({ setupMs, bodyMs: teardown - bodyStart, teardownMs: performance.now() - teardown })}`,
      );
    }
  });
  await Promise.all(
    [home, repo, profile, bin, path.join(root, "isolation")].map((directory) => mkdir(directory)),
  );
  const fixture = `
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('2.1.296 (Claude Code)'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--mcp-config <configs...> --settings <file-or-json>'); process.exit(0); }
const name = path.basename(process.cwd());
fs.writeFileSync(path.join(process.env.TEST_RECORDS, name + '.pending'), JSON.stringify({ pid: process.pid, env: { FOOM_CONTROL_URL: process.env.FOOM_CONTROL_URL, FOOM_CONTROL_TOKEN: process.env.FOOM_CONTROL_TOKEN, FOOM_CONTROL_INSTANCE: process.env.FOOM_CONTROL_INSTANCE }, args: process.argv.slice(2) }));
fs.renameSync(path.join(process.env.TEST_RECORDS, name + '.pending'), path.join(process.env.TEST_RECORDS, name + '.json'));
process.stdout.write('fixture-ready\\r\\n');
process.stdin.resume();
process.stdin.on('data', data => fs.appendFileSync(path.join(process.env.TEST_RECORDS, name + '.input'), data));
`;
  const executable = path.join(bin, process.platform === "win32" ? "claude.exe" : "claude");
  if (process.platform === "win32") await fixtureSea(root, executable, fixture);
  else await writeFile(executable, `#!${process.execPath}\n${fixture}`, { mode: 0o755 });
  const isolated = await isolatedEnvironment(path.join(root, "isolation"), bin);
  const oldUserInfo = os.userInfo;
  if (isolated.SHELL)
    os.userInfo = (...args) => ({ ...oldUserInfo(...args), shell: isolated.SHELL });
  const environment = gitEnvironment({
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(SystemRoot|SystemDrive|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR)$/i.test(key),
      ),
    ),
    ...isolated,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    TEST_RECORDS: root,
  });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  guardAgentProbes([bin, path.join(root, "isolation/bin")], path.join(root, "guard.log"));
  // Load production only after isolation and the exec guard have been installed.
  const {
    Workspace,
    WorktreeService,
    ControlRuntime,
    TerminalManager,
    VerdictLog,
    locationId,
  } = require("../../test-results/node-integration/core.cjs");
  await git(["init", "-q", "-b", "main"], { cwd: repo });
  await git(
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
  const worktrees = new WorktreeService(path.join(root, "trees"));
  const observe = (promise) => {
    events.push(
      promise.catch((error) => {
        failures.push(error);
      }),
    );
  };
  terminals = new TerminalManager((id, code) => observe(workspace.exited(id, code)), {
    onOutput: (id) => workspace.output(id),
    onEvidence: (id, evidence) => observe(workspace.evidence(id, evidence)),
    onQuiet: (id) => observe(workspace.quiet(id)),
  });
  let control;
  workspace = new Workspace({
    worktrees,
    terminals: {
      create: async (spec) => {
        assertFixtureAgent(spec.command, [bin]);
        return terminals.create({
          ...spec,
          env: { ...environment, ...spec.env },
          replaceEnvironment: true,
        });
      },
      kill: async (id) => terminals.kill(id),
      stop: (id) => terminals.stop(id),
      tail: (id, lines) => terminals.tail(id, lines),
      screen: (id) => terminals.screen(id),
      childInput: async (id, data) => {
        inputs.push({ id, data });
        terminals.childInput(id, data);
      },
      reply: async (id, data) => {
        inputs.push({ id, data });
        terminals.write(id, data);
      },
    },
    verdicts: new VerdictLog(profile),
    receiver: async () => {
      throw new Error("Hooks are disabled in this scenario");
    },
    onState: () => {},
    control: async () => {
      control ??= await ControlRuntime.start(
        profile,
        () => workspace.snapshot().terminals,
        undefined,
        workspace.orchestration,
        undefined,
        undefined,
        undefined,
        () =>
          worktrees
            .listRepositories()
            .map((entry) => ({ id: locationId(entry.path), name: entry.name })),
      );
      return control;
    },
  });
  workspace.configure({
    hooks: false,
    agents: { claude: true, codex: false, agy: false, copilot: false, opencode: false, pi: false },
  });
  const repository = (await workspace.addRepository(repo)).path;
  await workspace.sidebarCommand(
    { kind: "launch", repository, worktree: repository, run: "claude" },
    async () => true,
  );
  const wait = async (read, predicate) => {
    const until = Date.now() + deadline(15000);
    while (Date.now() < until) {
      const value = await read();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const row of workspace.snapshot().terminals)
      context.diagnostic(
        JSON.stringify({
          kind: row.kind,
          state: row.state,
          tail: await terminals.tail(row.id, 20),
        }),
      );
    assert.fail("Fixture state did not settle");
  };
  const credentials = (name) =>
    wait(
      async () =>
        existsSync(path.join(root, `${name}.json`))
          ? JSON.parse(await readFile(path.join(root, `${name}.json`), "utf8"))
          : null,
      Boolean,
    );
  const parent = await credentials("app");
  pids.push(parent.pid);
  const call = async (client, method, params = {}) => {
    const response = await fetch(client.env.FOOM_CONTROL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${client.env.FOOM_CONTROL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        instanceId: client.env.FOOM_CONTROL_INSTANCE,
        method,
        params,
      }),
    });
    return { status: response.status, body: await response.json() };
  };
  const parentId = (await call(parent, "whoami")).body.result.terminalId;
  assert.equal(
    (await call(parent, "create_worktree", { branch: "early", idempotencyKey: "early" })).status,
    403,
  );
  await workspace.sidebarCommand({ kind: "make-orchestrator", id: parentId }, async () => true);
  assert.equal((await call(parent, "whoami")).body.result.role, "orchestrator");
  bodyStart = performance.now();
  setupMs = bodyStart - started;
  const treeParams = { branch: "child-one", idempotencyKey: "tree" };
  const tree = await call(parent, "create_worktree", treeParams);
  assert.equal(tree.body.result.status, "succeeded", JSON.stringify(tree));
  assert.deepEqual(await call(parent, "create_worktree", treeParams), tree);
  const launched = await call(parent, "launch", {
    worktreeId: tree.body.result.resultId,
    agent: "claude",
    prompt: "Summarize the README",
    idempotencyKey: "launch",
  });
  assert.equal(launched.body.result.status, "succeeded", JSON.stringify(launched));
  const childId = launched.body.result.resultId;
  const child = await credentials("child-one");
  pids.push(child.pid);
  assert.match(child.args.at(-1), /Before stopping.*CI fails/s);
  assert.equal(
    (await call(child, "create_worktree", { branch: "forbidden", idempotencyKey: "forbidden" }))
      .status,
    403,
  );
  const row = workspace.snapshot().terminals.find((item) => item.id === childId);
  assert.ok(row);
  assert.equal(
    (await git(["branch", "--show-current"], { cwd: row.worktree })).stdout.trim(),
    "child-one",
  );
  await wait(
    () => terminals.tail(childId, 20),
    (lines) => lines.some((line) => line.includes("fixture-ready")),
  );
  const summary = "CI failed. <img src=x onerror=alert(1)>\n**Plain child-authored text**";
  const summaryFile = path.join(root, "handoff.txt");
  await writeFile(summaryFile, summary);
  const cli = async (client, args) =>
    JSON.parse(
      (
        await run(
          process.execPath,
          [
            "--require",
            path.resolve("tests/integration/no-electron.js"),
            path.join(output, "cli.cjs"),
            ...args,
            "--json",
          ],
          {
            env: { ...environment, ...client.env },
            timeout: deadline(15000),
          },
        )
      ).stdout,
    ).result;
  const state = (await call(parent, "session_state", { id: childId })).body.result;
  const waiting = call(parent, "wait_for", {
    ids: [childId],
    after: { [childId]: state.revision },
    timeoutMs: 10000,
  });
  const args = [
    "handoff",
    "--status",
    "failed",
    "--summary-file",
    summaryFile,
    "--link",
    "https://example.com/pull/514",
    "--idempotency-key",
    "report",
  ];
  const report = await cli(child, args);
  assert.equal(report.seq, 1);
  assert.deepEqual(await cli(child, args), report);
  assert.deepEqual((await call(parent, "session_state", { id: childId })).body.result.handoff, {
    seq: 1,
    status: "failed",
  });
  let woke = (await waiting).body.result;
  while (!woke.sessions[0].handoff) {
    assert.equal(woke.timedOut, false);
    woke = (
      await call(parent, "wait_for", {
        ids: [childId],
        after: { [childId]: woke.sessions[0].revision },
        timeoutMs: 10000,
      })
    ).body.result;
  }
  assert.equal(woke.timedOut, false);
  assert.deepEqual(woke.changed, [childId]);
  assert.deepEqual(woke.sessions[0].handoff, { seq: 1, status: "failed" });
  assert.ok(!JSON.stringify(woke).includes(summary));
  const pulled = await cli(parent, ["read-handoff", childId, "--seq", "1"]);
  assert.equal(pulled.summary, summary);
  assert.equal(pulled.untrusted, true);
  assert.deepEqual(pulled.links, ["https://example.com/pull/514"]);
  const log = await workspace.actionLog({ search: "", action: "handoff", status: "", offset: 0 });
  assert.equal(log.entries[0].actorId, childId);
  assert.equal(log.entries[0].parentId, parentId);
  assert.ok(!JSON.stringify(log).includes(summary));
  assert.deepEqual(inputs, []);
  assert.equal(existsSync(path.join(root, "child-one.input")), false);
  assert.equal(existsSync(path.join(root, "app.input")), false);
  await workspace.sidebarCommand({ kind: "take-over", id: childId }, async () => true);
  assert.equal(
    (await call(child, "handoff", { status: "done", summary: "later", idempotencyKey: "later" }))
      .body.error,
    "no_parent",
  );
  assert.equal((await call(parent, "read_handoff", { id: childId })).body.error, "not_found");
});
