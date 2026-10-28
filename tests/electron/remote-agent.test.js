const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const {
  mkdir,
  rename,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { gitSync } = require("../helpers/git.js");
const { launchTrustedParent } = require("./agent-fixture.js");
const { deadline, expect } = require("./test-policy.js");
const {
  FAKE_ORCHESTRATED_CLAUDE,
  launchApp,
  boardPage,
  quitAndWait,
  confirmationPage,
  fixtureCleanup,
  removeAfterApps,
} = require("./harness.js");
const { auditProcesses } = require("./process-audit.js");

test("a local orchestrator launches and resumes a remote child with private hooks, restricted MCP and handoff", {
  skip: process.platform === "win32",
  timeout: deadline(90_000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "fra-")));
  removeAfterApps(context, root);
  const remoteHome = await mkdtemp(path.join(await realpath("/tmp"), "rah-"));
  removeAfterApps(context, remoteHome);
  const bin = path.join(root, "bin");
  const remoteBin = path.join(root, "remote-bin");
  const repo = path.join(root, "app");
  const home = path.join(root, "home");
  const remoteRepo = path.join(root, "remote-repo");
  const remoteTree = path.join(root, "remote-tree");
  for (const dir of [bin, remoteBin, repo, home, remoteRepo, remoteTree])
    await mkdir(dir, { mode: 0o700 });
  await mkdir(path.join(remoteRepo, ".git", "worktrees", "fixture"), { recursive: true });
  await writeFile(
    path.join(remoteTree, ".git"),
    `gitdir: ${path.join(remoteRepo, ".git", "worktrees", "fixture")}\n`,
  );
  gitSync(["init", "-q", "-b", "main"], { cwd: repo });
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
    { cwd: repo },
  );
  await writeFile(
    path.join(bin, "claude"),
    FAKE_ORCHESTRATED_CLAUDE +
      `
const conversation = "saved-" + path.basename(process.cwd());
const req = require("node:http").request(process.env.FOOM_HOOK_URL, { method:"POST", headers:{Authorization:process.env.FOOM_TOKEN,"X-Foom-Session":process.env.FOOM_SESSION,"Content-Type":"application/json","X-Foom-Channel":process.env.FOOM_CHANNEL_lifecycle} }, res => res.resume());
req.on("error",()=>process.exit(1));
req.end(JSON.stringify({session_id:conversation,hook_event_name:"Stop"}));
`,
    { mode: 0o700 },
  );
  await symlink(process.execPath, path.join(bin, "node"));
  for (const tool of [
    "sh",
    "gzip",
    "uname",
    "head",
    "mkdir",
    "chmod",
    "mv",
    "mktemp",
    "sha256sum",
    "shasum",
    "cut",
    "wc",
    "tr",
    "rm",
    "ls",
  ]) {
    for (const directory of ["/usr/bin", "/bin"]) {
      try {
        await stat(path.join(directory, tool));
        await symlink(path.join(directory, tool), path.join(remoteBin, tool));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  const shell = path.join(remoteBin, "fixture-shell");
  await writeFile(
    shell,
    '#!/bin/sh\nif [ "$1" = "-ilc" ]; then printf "\\000FOOM_PATH\\000%s\\000" "$PATH"; exit 0; fi\nexec /bin/sh -i\n',
    { mode: 0o700 },
  );
  await writeFile(
    path.join(remoteBin, "git"),
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('worktree')) process.stdout.write('worktree ' + ${JSON.stringify(remoteTree)} + '\\0HEAD fixture\\0branch refs/heads/child-remote\\0\\0');
else if (args.includes('--git-common-dir')) console.log(${JSON.stringify(path.join(remoteRepo, ".git"))});
else if (args.includes('--absolute-git-dir')) console.log(${JSON.stringify(path.join(remoteRepo, ".git", "worktrees", "fixture"))});
else process.exit(2);
`,
    { mode: 0o700 },
  );
  const record = path.join(root, "remote-agent.json");
  const mcpRecord = path.join(root, "remote-mcp.json");
  await writeFile(
    path.join(remoteBin, "claude"),
    `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { writeFileSync, renameSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.296 (Claude Code)'); process.exit(0); }
if (args[0] === '--help') { console.log('--settings --mcp-config'); process.exit(0); }
const env = process.env;
const conversation = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : require('node:crypto').randomUUID();
function hook(event) {
  const result = spawnSync(env.FOOM_REMOTE_HELPER, ['--observe','lifecycle','stdin','silent','unordered'], { env, input: JSON.stringify({ session_id: conversation, hook_event_name: event, transcript_path: '/never/read' }), encoding: 'utf8' });
  if (result.status !== 0) throw new Error('fixture hook failed');
}
function save(file, value) { writeFileSync(file + '.tmp', JSON.stringify(value)); renameSync(file + '.tmp', file); }
const whoami = spawnSync(env.FOOM_REMOTE_HELPER, ['--cli','whoami','--json'], { env, encoding: 'utf8' });
save(${JSON.stringify(record)}, { args, env: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('FOOM_'))), pid: process.pid, whoami: whoami.stdout });
process.stdout.write('REMOTE_AGENT_READY\\r\\n');
hook('UserPromptSubmit');
process.stdin.setRawMode(true);
process.stdin.on('data', (bytes) => {
  const key = bytes.toString();
  if (key.includes('1')) {
    const messages = [
      {jsonrpc:'2.0', id:1, method:'initialize', params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}}},
      {jsonrpc:'2.0', method:'notifications/initialized'},
      {jsonrpc:'2.0', id:2, method:'tools/list'},
      {jsonrpc:'2.0', id:3, method:'tools/call', params:{name:'whoami',arguments:{}}},
      {jsonrpc:'2.0', id:4, method:'tools/call', params:{name:'manual',arguments:{}}},
      {jsonrpc:'2.0', id:5, method:'tools/call', params:{name:'open_preview',arguments:{path:'/remote/file'}}},
      {jsonrpc:'2.0', id:6, method:'tools/call', params:{name:'handoff',arguments:{status:'done',summary:'Remote fixture complete',review:{verdict:'clean'},idempotencyKey:'remote-report'}}},
    ];
    const result = spawnSync(env.FOOM_REMOTE_HELPER, ['--mcp'], { env, input: messages.map(value => JSON.stringify(value)).join('\\n') + '\\n', encoding:'utf8' });
    save(${JSON.stringify(mcpRecord)}, { status:result.status, output:result.stdout });
  }
  if (key.includes('2')) { hook('PermissionRequest'); process.stdout.write('Continue? (y/n)\\r\\n'); }
  if (key.includes('3')) {
    process.stdout.write('\\x1b[2J\\x1b[HREMOTE_WORKING\\r\\n');
    hook('PreToolUse');
  }
});
`,
    { mode: 0o700 },
  );
  const pids = path.join(root, "ssh-pids");
  await writeFile(
    path.join(bin, "ssh"),
    `#!${process.execPath}
const {spawn} = require('node:child_process');
const {appendFileSync} = require('node:fs');
const args = process.argv.slice(2); const split = args.indexOf('--');
if (args.at(-1) === 'uname -s; uname -m') { process.stdout.write(require('node:os').type() + '\\n' + (process.arch === 'x64' ? 'x86_64' : process.platform === 'darwin' ? 'arm64' : 'aarch64') + '\\n'); process.exit(0); }
if (args[split+1] !== 'fixture-agents') process.exit(2);
appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');
const child = spawn('/bin/sh',['-c','exec '+args.slice(split+2).join(' ')],{env:{HOME:${JSON.stringify(remoteHome)},PATH:${JSON.stringify(remoteBin)},SHELL:${JSON.stringify(shell)},LANG:'C'},stdio:['pipe','pipe','pipe']});
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.stdin.on('error',()=>{}); process.on('SIGTERM',()=>child.kill('SIGTERM')); child.on('close',code=>process.exit(code??1));
`,
    { mode: 0o700 },
  );
  const artifact = path.resolve("build/remote-host/foom-host");
  const cleanup = fixtureCleanup(context);
  cleanup.audit ??= await auditProcesses(context);
  const daemon = spawn(artifact, ["--daemon"], {
    env: { HOME: remoteHome, PATH: remoteBin, SHELL: shell },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cleanup.audit.add(daemon.pid);
  daemon.stderr.resume();
  cleanup.apps.push(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const closed = once(daemon, "close");
      daemon.kill("SIGTERM");
      await closed;
    }
  });
  await expect
    .poll(async () => {
      try {
        return (await stat(path.join(remoteHome, ".foom-host/host.sock"))).isSocket();
      } catch {
        return false;
      }
    })
    .toBe(true);
  const credentials = path.join(root, "credentials");
  let { app, page, parent } = await launchTrustedParent(context, {
    repo,
    credentials,
    options: {
      fixture: "agent",
      env: { HOME: home, PATH: bin, TEST_FAKE_CREDENTIALS: credentials },
    },
  });
  cleanup.apps.push(cleanup.apps.shift());
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
    const body = await response.json();
    assert.ok(body.result, JSON.stringify(body));
    return body.result;
  };
  const settle = async (method, params) => {
    let operation = await call(method, params);
    await expect
      .poll(
        async () => {
          if (operation.status === "running" || operation.status === "pending_confirmation")
            operation = await call("operation_status", { operationId: operation.operationId });
          return operation.status;
        },
        { timeout: deadline(30000) },
      )
      .toBe("succeeded");
    return operation;
  };
  const parentId = (await call("whoami")).terminalId;
  const elevate = page.evaluate(
    (id) => window.desktop.sidebarCommand({ kind: "make-orchestrator", id }),
    parentId,
  );
  const confirmation = await confirmationPage(app);
  await confirmation.getByRole("button", { name: "Make orchestrator" }).click();
  await elevate;
  const tree = await settle("create_worktree", {
    branch: "child-remote",
    idempotencyKey: "remote-tree",
  });
  const local = await page.evaluate(
    async (repository) =>
      (await window.desktop.worktrees(repository)).find((entry) => entry.branch === "child-remote")
        .path,
    repo,
  );
  await app.evaluate(
    (_electron, flags) => process.argv.push(...flags),
    [
      "--remote-agent-spike=fixture-agents",
      `--remote-agent-artifact=${artifact}`,
      `--remote-agent-local-checkout=${local}`,
      `--remote-agent-repository=${remoteRepo}`,
      `--remote-agent-worktree=${remoteTree}`,
    ],
  );
  // A real remote discovery miss must retain a fixed diagnostic, never host text.
  await rename(path.join(remoteBin, "claude"), path.join(remoteBin, "claude-hidden"));
  const missing = await call("launch", {
    worktreeId: tree.resultId,
    agent: "claude",
    idempotencyKey: "remote-missing-agent",
  });
  assert.equal(missing.status, "failed");
  assert.equal(missing.reason, "remote_agent_unavailable");
  await rename(path.join(remoteBin, "claude-hidden"), path.join(remoteBin, "claude"));
  const localTree = await settle("create_worktree", {
    branch: "child-local",
    idempotencyKey: "local-tree",
  });
  const unavailable = await call("launch", {
    worktreeId: localTree.resultId,
    agent: "codex",
    idempotencyKey: "local-missing-agent",
  });
  assert.equal(unavailable.status, "failed");
  assert.equal(unavailable.reason, "agent_unavailable");
  await page.evaluate(async () => {
    const { settings } = await window.desktop.setupState();
    await window.desktop.saveSetup({ agents: { ...settings.agents, claude: false } });
  });
  const disabled = await call("launch", {
    worktreeId: localTree.resultId,
    agent: "claude",
    idempotencyKey: "local-disabled-agent",
  });
  assert.equal(disabled.status, "failed");
  assert.equal(disabled.reason, "agent_disabled");
  await page.evaluate(async () => {
    const { settings } = await window.desktop.setupState();
    await window.desktop.saveSetup({ agents: { ...settings.agents, claude: true } });
  });
  const localChild = await settle("launch", {
    worktreeId: localTree.resultId,
    agent: "claude",
    idempotencyKey: "local-child",
  });
  assert.deepEqual(localChild.placement, { kind: "local" });
  const localRow = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
    (row) => row.id === localChild.resultId,
  );
  assert.deepEqual(localRow.placement, { kind: "local" });
  await expect
    .poll(async () => (await call("session_state", { id: localChild.resultId })).placement)
    .toEqual({ kind: "local" });
  const child = await settle("launch", {
    worktreeId: tree.resultId,
    agent: "claude",
    prompt: "Work on the remote fixture",
    idempotencyKey: "remote-launch",
  });
  assert.deepEqual(child.placement, { kind: "remote", host: "fixture-agents" });
  const id = child.resultId;
  const row = async () =>
    (await page.evaluate(() => window.desktop.workspace())).terminals.find(
      (entry) => entry.id === id,
    );
  await expect.poll(async () => (await row())?.execution?.phase).toBe("working");
  assert.equal((await row()).remote, true);
  assert.deepEqual((await call("session_state", { id })).placement, child.placement);
  const first = JSON.parse(await readFile(record, "utf8"));
  for (const secret of [id, parentId, parent.controlToken])
    assert.ok(!JSON.stringify(first).includes(secret));
  assert.equal(JSON.parse(first.whoami).role, "child");
  assert.ok(!JSON.parse(first.whoami).terminalId);
  await settle("send_keys", { id, keys: ["2"], idempotencyKey: "remote-permission" });
  await expect.poll(async () => (await row())?.execution?.phase).toBe("blocked");
  await settle("send_keys", { id, keys: ["1"], idempotencyKey: "remote-mcp" });
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(mcpRecord, "utf8")).status;
      } catch {
        return -1;
      }
    })
    .toBe(0);
  await expect.poll(async () => (await row())?.mcpConnection).toBe("connected");
  const mcp = JSON.parse(await readFile(mcpRecord, "utf8"));
  for (const secret of [id, parentId, parent.controlToken]) assert.ok(!mcp.output.includes(secret));
  const results = mcp.output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    results
      .find((value) => value.id === 2)
      .result.tools.map((tool) => tool.name)
      .sort(),
    ["handoff", "manual", "whoami"],
  );
  assert.equal(
    results.find((value) => value.id === 5).result.structuredContent.error,
    "phase_2_restricted",
  );
  assert.equal((await call("read_handoff", { id })).summary, "Remote fixture complete");
  await settle("send_keys", { id, keys: ["3"], idempotencyKey: "remote-working" });
  // The fixture has answered its permission prompt; do not race a working hook
  // against a still-visible screen blocker.
  await expect
    .poll(async () => (await page.evaluate((id) => window.desktop.tail(id, 40), id)).join("\n"))
    .toContain("REMOTE_WORKING");
  await expect.poll(async () => (await row())?.execution?.phase).toBe("working");
  const connectedPids = (await readFile(pids, "utf8")).trim().split("\n");
  const firstSsh = Number(connectedPids.at(-1));
  process.kill(firstSsh, "SIGTERM");
  await expect.poll(async () => (await readFile(pids, "utf8")).trim().split("\n").length).toBe(2);
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        try {
          return (await window.desktop.tail(id, 40)).join("\n");
        } catch {
          return "";
        }
      }, id),
    )
    .toContain("REMOTE_WORKING");
  await expect.poll(async () => (await row())?.exited).not.toBe(true);
  assert.equal(JSON.parse(await readFile(record, "utf8")).pid, first.pid);
  await settle("stop", { id, idempotencyKey: "remote-stop" });
  await expect.poll(async () => (await row())?.exited).toBe(true);
  await expect
    .poll(async () => {
      try {
        await stat(first.env.FOOM_REMOTE_SOCKET);
        return false;
      } catch {
        return true;
      }
    })
    .toBe(true);
  await page.evaluate((id) => window.desktop.sidebarCommand({ kind: "resume", id }), id);
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(record, "utf8")).pid;
      } catch {
        return first.pid;
      }
    })
    .not.toBe(first.pid);
  const resumed = JSON.parse(await readFile(record, "utf8"));
  assert.ok(resumed.args.includes("--resume"));
  await expect.poll(async () => (await row())?.execution?.phase).toBe("working");
  assert.notEqual(JSON.parse(resumed.whoami).alias, JSON.parse(first.whoami).alias);
  const profile = await app.evaluate(({ app }) => app.getPath("userData"));
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.workspace())).terminals.find(
          (row) => row.id === localChild.resultId,
        )?.conversationId,
    )
    .toBeTruthy();
  await quitAndWait(app, async () => {
    await app.evaluate(({ app }) => app.quit());
    const dialog = await confirmationPage(app);
    await dialog.getByRole("button", { name: "Stop all and quit" }).click();
  });
  // Quit detaches the remote process. Restore deliberately maps the formerly local
  // checkout: saved placement must survive without rerouting that local child.
  process.kill(resumed.pid, 0);
  app = await launchApp(context, {
    fixture: "restored",
    args: [
      `--user-data-dir=${profile}`,
      "--remote-agent-spike=fixture-agents",
      `--remote-agent-artifact=${artifact}`,
      `--remote-agent-local-checkout=${localRow.worktree}`,
      `--remote-agent-repository=${remoteRepo}`,
      `--remote-agent-worktree=${remoteTree}`,
    ],
    env: { HOME: home, PATH: bin, TEST_FAKE_CREDENTIALS: credentials },
  });
  page = await boardPage(app);
  await expect.poll(async () => (await row())?.dormant).toBe(true);
  assert.equal((await row()).remote, true);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.workspace())).terminals.find(
          (row) => row.id === localChild.resultId,
        )?.dormant,
    )
    .not.toBe(true);
  const restoredLocal = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
    (row) => row.id === localChild.resultId,
  );
  assert.equal(restoredLocal.remote, undefined);
  assert.deepEqual(restoredLocal.placement, { kind: "local" });
  await expect
    .poll(async () => {
      parent = JSON.parse(await readFile(`${credentials}.app`, "utf8"));
      try {
        return (await call("whoami")).role;
      } catch {
        return "waiting";
      }
    })
    .toBe("orchestrator");
  await rename(path.join(bin, "ssh"), path.join(bin, "ssh-hidden"));
  const unreachable = await call("close", { id, idempotencyKey: "unreachable-close" });
  assert.equal(unreachable.status, "failed");
  assert.equal(unreachable.reason, "remote_host_unreachable");
  assert.equal((await call("session_state", { id })).reason, "remote_host_unreachable");
  process.kill(resumed.pid, 0);
  await rename(path.join(bin, "ssh-hidden"), path.join(bin, "ssh"));
  await settle("close", { id, idempotencyKey: "close-after-restart" });
  await expect
    .poll(() => {
      try {
        process.kill(resumed.pid, 0);
        return false;
      } catch {
        return true;
      }
    })
    .toBe(true);
  await assert.rejects(stat(path.dirname(resumed.env.FOOM_REMOTE_SOCKET)), { code: "ENOENT" });
  assert.equal(await row(), undefined);
  const saved = JSON.parse(await readFile(path.join(profile, "sessions.json"), "utf8"));
  assert.equal(saved.find((row) => row.id === localChild.resultId).remote, undefined);
});
