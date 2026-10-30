const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createHash } = require("node:crypto");
const {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  rename,
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
  boardPage,
  launchApp,
  quitAndWait,
  confirmationPage,
  fixtureCleanup,
  removeAfterApps,
} = require("./harness.js");
const { auditProcesses } = require("./process-audit.js");

test("registered-host orchestration launches Codex, Copilot and Antigravity using host inventory and restricted child tools", {
  skip: process.platform === "win32",
  timeout: deadline(90000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "rfl-")));
  removeAfterApps(context, root);
  const remoteHome = await mkdtemp(path.join(await realpath("/tmp"), "rfh-"));
  removeAfterApps(context, remoteHome);
  const bin = path.join(root, "bin");
  const remoteBin = path.join(root, "remote-bin");
  const repo = path.join(root, "app");
  const home = path.join(root, "home");
  for (const directory of [bin, remoteBin, repo, home]) await mkdir(directory, { mode: 0o700 });
  gitSync(["init", "-q", "-b", "main"], { cwd: repo });
  gitSync(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ],
    { cwd: repo },
  );
  const origin = "git@fixture.test:team/repo.git";
  gitSync(["remote", "add", "origin", origin], { cwd: repo });
  const folder = path.join(remoteHome, "code");
  const remoteRepo = path.join(
    folder,
    `repository-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`,
  );
  await mkdir(path.join(remoteRepo, ".git"), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(bin, "claude"),
    FAKE_ORCHESTRATED_CLAUDE +
      `
const notify = require('node:http').request(process.env.FOOM_HOOK_URL, {method:'POST', headers:{Authorization:process.env.FOOM_TOKEN,'X-Foom-Session':process.env.FOOM_SESSION,'X-Foom-Channel':process.env.FOOM_CHANNEL_lifecycle,'Content-Type':'application/json'}}, response => response.resume());
notify.on('error', () => {});
notify.end(JSON.stringify({session_id:'fleet-parent-conversation',hook_event_name:'Stop'}));
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
  const gitState = path.join(root, "remote-git.json");
  await writeFile(gitState, "{}");
  await writeFile(
    path.join(remoteBin, "git"),
    `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), cwd = process.cwd();
const state = JSON.parse(fs.readFileSync(${JSON.stringify(gitState)}, 'utf8'));
if (args.includes('config')) console.log(${JSON.stringify(origin)});
else if (args.includes('--show-toplevel')) console.log(cwd);
else if (args.includes('--git-common-dir')) console.log(${JSON.stringify(path.join(remoteRepo, ".git"))});
else if (args.includes('--absolute-git-dir')) console.log(path.join(${JSON.stringify(path.join(remoteRepo, ".git", "worktrees"))},path.basename(cwd)));
else if (args.includes('ls-remote')) process.stdout.write('ref: refs/heads/main\\tHEAD\\n');
else if (args.includes('symbolic-ref')) console.log(state[cwd]);
else if (args.includes('worktree') && args.includes('add')) {
 const destination=args[args.indexOf('--')+1]; fs.mkdirSync(destination,{mode:0o700}); const metadata=path.join(${JSON.stringify(path.join(remoteRepo, ".git", "worktrees"))},path.basename(destination)); fs.mkdirSync(metadata,{recursive:true,mode:0o700}); fs.writeFileSync(path.join(destination,'.git'),'gitdir: '+metadata+'\\n'); state[destination]=args[args.indexOf('-b')+1]; fs.writeFileSync(${JSON.stringify(gitState)},JSON.stringify(state));
} else if (args.includes('worktree') && args.includes('list')) {
 for (const [directory,branch] of Object.entries(state)) process.stdout.write('worktree '+directory+'\\0HEAD '+ 'a'.repeat(40)+'\\0branch refs/heads/'+branch+'\\0\\0');
} else if (args.includes('worktree') && args.includes('remove')) {const directory=args.at(-1); fs.rmSync(directory,{recursive:true}); delete state[directory]; fs.writeFileSync(${JSON.stringify(gitState)},JSON.stringify(state));}
else if (args.includes('status') || args.includes('check-ref-format') || args.includes('fetch') || args.includes('for-each-ref')) {}
else if (args.includes('--verify')) console.log('a'.repeat(40));
else process.exit(2);
`,
    { mode: 0o700 },
  );
  for (const agent of ["codex", "copilot", "agy"]) {
    await writeFile(
      path.join(remoteBin, agent),
      `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), {spawnSync} = require('node:child_process');
const agent = ${JSON.stringify(agent)}, args=process.argv.slice(2);
if (args[0]==='--version') {console.log({codex:'codex-cli 0.161.0',copilot:'GitHub Copilot CLI 1.0.103.',agy:'1.4.2'}[agent]); process.exit(0);}
if (args[0]==='--help') {console.log('-c --no-alt-screen --plugin-dir --additional-mcp-config --allow-tool --session-id --resume --interactive --prompt-interactive --conversation'); process.exit(0);}
if (args[0]==='plugin') {console.log('[]'); process.exit(0);}
const env=process.env;
fs.writeFileSync(${JSON.stringify(path.join(root, `${agent}-launch.json`))},JSON.stringify({args,cwd:process.cwd(),env:Object.fromEntries(Object.entries(env).filter(([key])=>key.startsWith('FOOM_'))),pid:process.pid}));
process.stdout.write('REMOTE_'+agent.toUpperCase()+'_READY\\r\\n'); process.stdin.setRawMode(true);
process.stdin.on('data', bytes=>{
 if(!bytes.toString().includes('1')) return;
 const cli=(words,input)=>{const result=spawnSync(env.FOOM_REMOTE_HELPER,['--cli',...words,'--json'],{env,input,encoding:'utf8'}); return {code:result.status,output:result.stdout};};
 const identity=cli(['whoami']), forbidden=cli(['sessions']);
 let mcp;
 if(agent!=='agy') {
  const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'whoami',arguments:{}}}];
  const result=spawnSync(env.FOOM_REMOTE_HELPER,['--mcp'],{env,input:messages.map(value=>JSON.stringify(value)).join('\\n')+'\\n',encoding:'utf8'}); mcp={code:result.status,output:result.stdout};
 }

 const handoff=cli(['handoff','--status','done','--summary-file','-','--idempotency-key','fixture-'+agent],agent+' fixture complete');
 fs.writeFileSync(${JSON.stringify(path.join(root, `${agent}-report.json`))},JSON.stringify({identity,forbidden,handoff,mcp}));
});
`,
      { mode: 0o700 },
    );
  }
  const sshCalls = path.join(root, "ssh-calls");
  await writeFile(
    path.join(bin, "ssh"),
    `#!${process.execPath}
const {spawn} = require('node:child_process'), {appendFileSync}=require('node:fs');
const args=process.argv.slice(2), split=args.indexOf('--');
if(args[split+1]!=='fleet-worker') process.exit(2);
appendFileSync(${JSON.stringify(sshCalls)},'ssh\\n');
if(args.at(-1)==='uname -s; uname -m') {process.stdout.write(require('node:os').type()+'\\n'+(process.arch==='x64'?'x86_64':process.platform==='darwin'?'arm64':'aarch64')+'\\n');process.exit(0);}
const child=spawn('/bin/sh',['-c','exec '+args.slice(split+2).join(' ')],{env:{HOME:${JSON.stringify(remoteHome)},PATH:${JSON.stringify(remoteBin)},SHELL:${JSON.stringify(shell)},LANG:'C'},stdio:['pipe','pipe','pipe']});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.stdin.on('error',()=>{});
process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('close',code=>process.exit(code??1));
`,
    { mode: 0o700 },
  );
  const cleanup = fixtureCleanup(context);
  cleanup.audit ??= await auditProcesses(context);
  const artifact = path.resolve("build/remote-host/foom-host");
  const daemon = spawn(artifact, ["--daemon"], {
    env: { HOME: remoteHome, PATH: remoteBin, SHELL: shell },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cleanup.audit.add(daemon.pid);
  daemon.stdout.resume();
  daemon.stderr.resume();
  const closeDaemon = async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const closed = once(daemon, "close");
      daemon.kill("SIGTERM");
      await closed;
    }
  };
  cleanup.apps.push(closeDaemon);
  await expect
    .poll(async () => {
      try {
        return (await stat(path.join(remoteHome, ".foom-host/host-v2.sock"))).isSocket();
      } catch {
        return false;
      }
    })
    .toBe(true);
  const credentials = path.join(root, "credentials");
  const profile = path.join(root, "profile");
  const launchOptions = {
    fixture: "agent",
    args: [`--user-data-dir=${profile}`],
    env: { HOME: home, PATH: bin, TEST_FAKE_CREDENTIALS: credentials },
  };
  const { app, page, parent } = await launchTrustedParent(context, {
    repo,
    credentials,
    options: launchOptions,
  });
  cleanup.apps.push(cleanup.apps.shift());
  const controlCall = async (actor, method, params = {}) => {
    const response = await fetch(actor.controlUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${actor.controlToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ version: 1, instanceId: actor.instanceId, method, params }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result.result;
  };
  const call = (method, params) => controlCall(parent, method, params);
  const parentId = (await call("whoami")).terminalId;
  await page.evaluate(() => window.desktop.saveSetup({ closeFinishedAgents: false }));
  let persistent;
  const elevate = page.evaluate(
    (id) => window.desktop.sidebarCommand({ kind: "make-orchestrator", id }),
    parentId,
  );
  await (await confirmationPage(app)).getByRole("button", { name: "Make orchestrator" }).click();
  await elevate;
  const registration = await page.evaluate(
    (folder) => window.desktop.hosts({ action: "add", host: "fleet-worker", codeFolder: folder }),
    folder,
  );
  assert.equal(registration.result.ok, true, JSON.stringify(registration));
  const sessions = await call("sessions");
  const worker = sessions.hosts.find((host) => host.host === "fleet-worker");
  assert.ok(worker.resources.cores > 0);
  assert.ok(worker.resources.memoryTotal >= worker.resources.memoryAvailable);
  for (const agent of ["codex", "copilot", "agy"])
    assert.equal(worker.agents.find((entry) => entry.id === agent).state, "ready");
  assert.ok(sessions.hosts.some((host) => host.host === null));
  const tree = await call("create_worktree", {
    host: "fleet-worker",
    branch: "missing-agent",
    idempotencyKey: "missing-tree",
  });
  assert.equal(tree.status, "succeeded", JSON.stringify(tree));
  await rename(path.join(remoteBin, "codex"), path.join(remoteBin, "codex-hidden"));
  await page.evaluate(() => window.desktop.hosts({ action: "refresh", host: "fleet-worker" }));
  const before = await readFile(sshCalls, "utf8");
  const missing = await call("launch", {
    host: "fleet-worker",
    worktreeId: tree.resultId,
    agent: "codex",
    idempotencyKey: "missing-agent",
  });
  assert.equal(missing.status, "failed");
  assert.equal(missing.reason, "remote_agent_unavailable");
  assert.equal(await readFile(sshCalls, "utf8"), before);
  await rename(path.join(remoteBin, "codex-hidden"), path.join(remoteBin, "codex"));
  await page.evaluate(() => window.desktop.hosts({ action: "refresh", host: "fleet-worker" }));
  for (const agent of ["codex", "copilot", "agy"]) {
    const checkout =
      agent === "codex"
        ? tree
        : await call("create_worktree", {
            host: "fleet-worker",
            branch: `child-${agent}`,
            idempotencyKey: `tree-${agent}`,
          });
    assert.equal(checkout.status, "succeeded", JSON.stringify(checkout));
    const launched = await call("launch", {
      host: "fleet-worker",
      worktreeId: checkout.resultId,
      agent,
      prompt: "Complete the fixture task",
      idempotencyKey: `launch-${agent}`,
    });
    assert.equal(launched.status, "succeeded", agent + ": " + JSON.stringify(launched));
    assert.deepEqual(launched.placement, { kind: "remote", host: "fleet-worker" });
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(path.join(root, `${agent}-launch.json`), "utf8"));
        } catch {
          return null;
        }
      })
      .not.toBeNull();
    const record = JSON.parse(await readFile(path.join(root, `${agent}-launch.json`), "utf8"));
    assert.ok(record.cwd.startsWith(folder + "/.foom-worktree-"));
    const serialized = JSON.stringify(record);
    assert.ok(!serialized.includes(parentId));
    assert.ok(!serialized.includes(launched.resultId));
    assert.ok(!serialized.includes(parent.controlToken));
    assert.ok(!Object.hasOwn(record.env, "FOOM_CONTROL_URL"));
    assert.ok(!Object.hasOwn(record.env, "FOOM_CONTROL_TOKEN"));
    const row = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
      (row) => row.id === launched.resultId,
    );
    assert.ok(row.branch.includes("fleet-worker"));
    await expect(page.getByText(row.branch, { exact: true }).first()).toBeVisible();
    assert.equal(
      (await call("session_state", { id: launched.resultId, host: "fleet-worker" })).host,
      "fleet-worker",
    );
    await call("send_keys", {
      id: launched.resultId,
      keys: ["1"],
      idempotencyKey: `report-${agent}`,
    });
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(path.join(root, `${agent}-report.json`), "utf8"));
        } catch {
          return null;
        }
      })
      .not.toBeNull();
    const report = JSON.parse(await readFile(path.join(root, `${agent}-report.json`), "utf8"));
    assert.equal(JSON.parse(report.identity.output).role, "child");
    assert.equal(JSON.parse(report.forbidden.output).error, "phase_2_restricted");
    if (agent !== "agy") {
      assert.equal(report.mcp.code, 0);
      const responses = report.mcp.output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        responses
          .find((value) => value.id === 2)
          .result.tools.map((tool) => tool.name)
          .sort(),
        ["handoff", "manual", "whoami"],
      );
      if (agent === "codex")
        assert.ok(
          record.args.some((arg) => arg.startsWith("mcp_servers.") && arg.includes("command=")),
        );
      else assert.ok(record.args.includes("--additional-mcp-config"));
    }
    assert.ok(!JSON.stringify(report).includes(parentId));
    assert.ok(!JSON.stringify(report).includes(launched.resultId));
    await expect
      .poll(async () => (await call("read_handoff", { id: launched.resultId })).summary)
      .toBe(`${agent} fixture complete`);
    if (agent === "codex") {
      persistent = {
        id: launched.resultId,
        pid: record.pid,
        alias: JSON.parse(report.identity.output).alias,
      };
      continue;
    }
    await call("stop", { id: launched.resultId, idempotencyKey: `stop-${agent}` });
    await expect
      .poll(async () => (await call("session_state", { id: launched.resultId })).state)
      .toBe("exited");
    if (agent === "copilot") {
      await page.evaluate(
        (id) => window.desktop.sidebarCommand({ kind: "resume", id }),
        launched.resultId,
      );
      await expect
        .poll(
          async () =>
            JSON.parse(await readFile(path.join(root, `${agent}-launch.json`), "utf8")).pid,
        )
        .not.toBe(record.pid);
      const resumed = JSON.parse(await readFile(path.join(root, `${agent}-launch.json`), "utf8"));
      assert.ok(resumed.args.includes("--resume"));
      assert.ok(resumed.cwd === record.cwd);
      await call("stop", { id: launched.resultId, idempotencyKey: "stop-resumed-copilot" });
      await expect
        .poll(async () => (await call("session_state", { id: launched.resultId })).state)
        .toBe("exited");
    }
    if (agent === "agy") {
      const removal = await call("remove_worktree", {
        worktreeId: checkout.resultId,
        idempotencyKey: "remove-agy",
      });
      const dialog = await confirmationPage(app);
      await expect(dialog.getByText(`fleet-worker:${record.cwd}`, { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Remove worktree", exact: true }).click();
      await expect
        .poll(
          async () => (await call("operation_status", { operationId: removal.operationId })).status,
        )
        .toBe("succeeded");
      assert.ok(!Object.hasOwn(JSON.parse(await readFile(gitState, "utf8")), record.cwd));
    }
  }
  assert.ok(persistent);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.workspace())).terminals.find(
          (row) => row.id === parentId,
        )?.conversationId,
    )
    .toBe("fleet-parent-conversation");
  await quitAndWait(app, async () => {
    await app.evaluate(({ app }) => app.quit());
    await (await confirmationPage(app)).getByRole("button", { name: "Stop all and quit" }).click();
  });
  const restarted = await launchApp(context, { ...launchOptions, fixture: "restored" }).finally(
    () => {
      cleanup.apps.splice(cleanup.apps.indexOf(closeDaemon), 1);
      cleanup.apps.push(closeDaemon);
    },
  );
  const restored = await boardPage(restarted);
  await expect
    .poll(
      async () =>
        (await restored.evaluate(() => window.desktop.workspace())).terminals.find(
          (row) => row.id === persistent.id,
        )?.orchestration?.role,
    )
    .toBe("child");
  await expect
    .poll(
      async () =>
        (await restored.evaluate(() => window.desktop.workspace())).terminals.find(
          (row) => row.id === persistent.id,
        )?.dormant,
    )
    .toBe(false);
  assert.equal(
    JSON.parse(await readFile(path.join(root, "codex-launch.json"), "utf8")).pid,
    persistent.pid,
  );
  await expect
    .poll(async () =>
      (await restored.evaluate((id) => window.desktop.tail(id, 40), persistent.id)).join("\n"),
    )
    .toContain("REMOTE_CODEX_READY");
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(`${credentials}.app`, "utf8")).controlToken !==
        parent.controlToken,
    )
    .toBe(true);
  const newParent = JSON.parse(await readFile(`${credentials}.app`, "utf8"));
  const restoredCall = (method, params) => controlCall(newParent, method, params);
  await rm(path.join(root, "codex-report.json"));
  await restoredCall("send_keys", {
    id: persistent.id,
    keys: ["1"],
    idempotencyKey: "after-restart-report",
  });
  await expect
    .poll(async () => {
      try {
        return (
          JSON.parse(await readFile(path.join(root, "codex-report.json"), "utf8")).identity.code ===
          0
        );
      } catch {
        return false;
      }
    })
    .toBe(true);
  const renewed = JSON.parse(await readFile(path.join(root, "codex-report.json"), "utf8"));
  assert.equal(JSON.parse(renewed.identity.output).role, "child");
  assert.ok(JSON.parse(renewed.identity.output).alias !== persistent.alias);
  await restoredCall("stop", { id: persistent.id, idempotencyKey: "stop-after-restart" });
  await expect
    .poll(async () => (await restoredCall("session_state", { id: persistent.id })).state)
    .toBe("exited");
});
