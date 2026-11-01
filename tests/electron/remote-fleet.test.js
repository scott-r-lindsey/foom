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
const { FAKE_GH } = require("../helpers/forge-cli.js");
const { gitSync } = require("../helpers/git.js");
const { launchTrustedParent } = require("./agent-fixture.js");
const { deadline, expect } = require("./test-policy.js");
const {
  FAKE_ORCHESTRATED_CLAUDE,
  boardPage,
  launchApp,
  quitAndWait,
  confirmationPage,
  openSettingsScreen,
  fixtureCleanup,
  createMemoryFixture,
  removeAfterApps,
} = require("./harness.js");
const { auditProcesses } = require("./process-audit.js");

async function copyRemoteBranch(app, page, expected) {
  await page.getByRole("button", { name: `Actions for ${expected}`, exact: true }).click();
  const panel = page.getByRole("dialog", { name: `${expected} details and commands`, exact: true });
  const copy = panel.getByRole("button", { name: "Copy branch", exact: true });
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(expected);
  await expect(copy).toHaveAttribute("data-copied", "true");
  await page.keyboard.press("Escape");
}

async function remoteFleet(context, agents, restart = false, reviewLoop = false) {
  const started = performance.now();
  const restartTiming = (stage) => {
    if (restart)
      context.diagnostic(`Remote restart ${stage}: ${Math.round(performance.now() - started)}ms`);
  };
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
  const origin = reviewLoop
    ? "https://github.com/fixture/offline.git"
    : "git@fixture.test:team/repo.git";
  gitSync(["remote", "add", "origin", origin], { cwd: repo });
  const forgeState = path.join(root, "forge.json");
  const forgeCalls = path.join(root, "forge-calls");
  if (reviewLoop) {
    await writeFile(forgeCalls, "");
    await writeFile(
      path.join(bin, "gh"),
      FAKE_GH.replace(
        "const args = process.argv.slice(2);",
        `const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(forgeCalls)}, (args[0] === "api" && args[5]?.includes("pullRequest(number: 340)") ? "remote-status" : args[0]) + "\\n");`,
      ),
      { mode: 0o700 },
    );
    await writeFile(
      forgeState,
      JSON.stringify({
        pr: { headRefName: "missing-agent", headRefOid: "a".repeat(40) },
        checks: [{ bucket: "pass" }],
      }),
    );
  }
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
    path.join(remoteBin, reviewLoop ? "git-fixture.js" : "git"),
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
 const destination=args[args.indexOf('--')+1]; fs.mkdirSync(destination,{mode:0o700,recursive:true}); const metadata=path.join(${JSON.stringify(path.join(remoteRepo, ".git", "worktrees"))},path.basename(destination)); fs.mkdirSync(metadata,{recursive:true,mode:0o700}); fs.writeFileSync(path.join(destination,'.git'),'gitdir: '+metadata+'\\n'); state[destination]=args[args.indexOf('-b')+1]; fs.writeFileSync(path.join(metadata,'fixture-branch'),state[destination]+'\\n'); fs.writeFileSync(${JSON.stringify(gitState)},JSON.stringify(state));
} else if (args.includes('worktree') && args.includes('list')) {
 for (const [directory,branch] of Object.entries(state)) process.stdout.write('worktree '+directory+'\\0HEAD '+ 'a'.repeat(40)+'\\0branch refs/heads/'+branch+'\\0\\0');
} else if (args.includes('worktree') && args.includes('remove')) {const directory=args.at(-1); fs.rmSync(directory,{recursive:true}); delete state[directory]; fs.writeFileSync(${JSON.stringify(gitState)},JSON.stringify(state));}
else if (args.includes('status') || args.includes('check-ref-format') || args.includes('fetch') || args.includes('for-each-ref')) {}
else if (args.includes('--git-path')) console.log(path.join(cwd, '.snapshot-missing'));
else if (args.includes('--symbolic-full-name')) console.log('refs/heads/'+state[cwd]);
else if (args.includes('rev-parse')) console.log('a'.repeat(40));
else if (args.includes('ls-files')) {}
else process.exit(2);
`,
    { mode: 0o700 },
  );
  if (reviewLoop) {
    await symlink(process.execPath, path.join(remoteBin, "node"));
    // Snapshot reads need fixed facts, not a new Node VM for each Git argument array.
    // Mutations still run the stateful fixture; no system Git or network runs.
    await writeFile(
      path.join(remoteBin, "git"),
      [
        "#!/bin/sh",
        'case " $* " in',
        "  *' config '*) printf '%s\\n' \"$FIXTURE_REMOTE_ORIGIN\";;",
        "  *' --show-toplevel '*) pwd -P;;",
        "  *' --git-common-dir '*) printf '%s/.git\\n' \"$FIXTURE_REMOTE_GIT_ROOT\";;",
        "  *' --absolute-git-dir '*) printf '%s/.git/worktrees/%s\\n' \"$FIXTURE_REMOTE_GIT_ROOT\" \"${PWD##*/}\";;",
        "  *' --git-path '*) printf '%s/.snapshot-missing\\n' \"$PWD\";;",
        "  *' --symbolic-full-name '*) IFS= read -r branch < \"$FIXTURE_REMOTE_GIT_ROOT/.git/worktrees/${PWD##*/}/fixture-branch\"; printf 'refs/heads/%s\\n' \"$branch\";;",
        "  *' symbolic-ref '*) IFS= read -r branch < \"$FIXTURE_REMOTE_GIT_ROOT/.git/worktrees/${PWD##*/}/fixture-branch\"; printf '%s\\n' \"$branch\";;",
        '  *\' worktree list \'*) for record in "$FIXTURE_REMOTE_GIT_ROOT"/.git/worktrees/.foom-worktree-*/fixture-branch; do [ -f "$record" ] || continue; IFS= read -r branch < "$record"; metadata="${record%/fixture-branch}"; printf \'worktree %s/%s\\000HEAD %s\\000branch refs/heads/%s\\000\\000\' "${FIXTURE_REMOTE_GIT_ROOT%/*}" "${metadata##*/}" "$FIXTURE_REMOTE_HEAD" "$branch"; done;;',
        "  *' ls-remote '*) printf 'ref: refs/heads/main\\tHEAD\\n';;",
        "  *' rev-parse '*) printf '%s\\n' \"$FIXTURE_REMOTE_HEAD\";;",
        "  *' status '*|*' check-ref-format '*|*' fetch '*|*' for-each-ref '*|*' ls-files '*) exit 0;;",
        '  *) exec node "${0%/*}/git-fixture.js" "$@";;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
  }
  for (const agent of agents) {
    await writeFile(
      path.join(remoteBin, agent),
      `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), {spawnSync} = require('node:child_process');
const agent = ${JSON.stringify(agent)}, args=process.argv.slice(2);
if (args[0]==='--version') {console.log({codex:'codex-cli 0.161.0',copilot:'GitHub Copilot CLI 1.0.103.',agy:'1.4.2',pi:'1.4.0',opencode:'opencode v2.0.32'}[agent]); process.exit(0);}
if (args[0]==='--help') {console.log('-c --no-alt-screen --plugin-dir --additional-mcp-config --allow-tool --session-id --resume --interactive --prompt-interactive --conversation --extension --session --standalone --prompt'); process.exit(0);}
if (args[0]==='plugin') {console.log('[]'); process.exit(0);}
if (agent==='codex' && args[0]==='login' && args[1]==='status') process.exit(0);
const env=process.env;
const reviewLoop=${JSON.stringify(reviewLoop)};
const reviewer=reviewLoop && args.some(arg=>arg.includes('Review PR #340'));
const resumed=reviewLoop && !reviewer && args.includes('resume');
(async () => {
let attachment, cleanup;
if(reviewLoop) {
 const conversation=reviewer ? 'review-'+process.pid : 'author-conversation';
 for(const event of ['SessionStart','Stop']) {
  const result=spawnSync(env.FOOM_REMOTE_HELPER,['--observe','lifecycle','stdin','silent','unordered'],{env,input:JSON.stringify({session_id:conversation,hook_event_name:event,source:resumed?"resume":"startup",turn_id:"fixture-turn",stop_hook_active:false}),encoding:'utf8'});
  if(result.status!==0) throw new Error('Fixture hook failed');
 }
}
const conversation=args[args.indexOf(agent==='pi' && args.includes('--session-id')?'--session-id':'--session')+1];
if(agent==='pi') {
 const handlers=new Map();
 const file=args[args.indexOf('--extension')+1];
 const extension=(await import(require('node:url').pathToFileURL(file).href)).default;
 extension({on(name, handler){const previous=handlers.get(name); handlers.set(name, async (...args)=>{await previous?.(...args); await handler(...args);});},
 registerMcpServer(name, config){attachment={name,...config};}, unregisterMcpServer(){attachment=undefined;}});
 const ctx={sessionManager:{getSessionId:()=>conversation},isIdle:()=>true};
 for (const name of ['session_start','before_agent_start','agent_start','agent_before_settle','agent_settled'])
   await handlers.get(name)?.({outcome:'completed',aborted:false},ctx);
 if(!attachment) throw new Error('Pi did not consume extension');
} else if(agent==='opencode') {
 const config=JSON.parse(env.OPENCODE_CONFIG_CONTENT);
 attachment=Object.values(config.mcp.servers)[0];
 const hooks=JSON.parse(fs.readFileSync(env.OPENCODE_CONFIG,'utf8'));
 const plugin=(await import(require('node:url').pathToFileURL(path.join(hooks.plugins[0],'index.mjs')).href)).default;
 cleanup=plugin.setup({event:{async *subscribe(){
  yield {id:'start',type:'session.execution.started',data:{sessionID:conversation,secret:'must not relay'}};
  yield {id:'end',type:'session.execution.succeeded',data:{sessionID:conversation}};
 }}});
}
fs.writeFileSync(${JSON.stringify(path.join(root, `${agent}-launch.json`))},JSON.stringify({args,reviewer,resumed,cwd:process.cwd(),env:Object.fromEntries(Object.entries(env).filter(([key])=>key.startsWith('FOOM_'))),pid:process.pid,attachment,hookFile:env.OPENCODE_CONFIG}));
process.stdout.write('REMOTE_'+agent.toUpperCase()+'_READY\\r\\n'); process.stdin.setRawMode(true);
process.stdin.on('data', bytes=>{
 if(!bytes.toString().includes('1')) return;
 const cli=(words,input)=>{const result=spawnSync(env.FOOM_REMOTE_HELPER,['--cli',...words,'--json'],{env,input,encoding:'utf8'}); return {code:result.status,output:result.stdout};};
 const identity=cli(['whoami']), forbidden=cli(['sessions']);
 let mcp;
 if(agent!=='agy') {
  const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'whoami',arguments:{}}}];
  const command=agent==='pi'?attachment.command:agent==='opencode'?attachment.command[0]:env.FOOM_REMOTE_HELPER;
  const argv=agent==='pi'?attachment.args:agent==='opencode'?attachment.command.slice(1):['--mcp'];
  const result=spawnSync(command,argv,{env,input:messages.map(value=>JSON.stringify(value)).join('\\n')+'\\n',encoding:'utf8'}); mcp={code:result.status,output:result.stdout};
 }

 const verdict=reviewer ? (reviewLoop==='clean' ? {verdict:'clean'} : {verdict:'findings',findings:[{file:'a.ts',line:1,summary:'Fixture defect',scenario:'Zero input'}]}) : undefined;
 const handoff=cli(['handoff','--status',resumed && reviewLoop==='findings' ? 'blocked' : 'done','--summary-file','-','--idempotency-key','fixture-'+agent,...(verdict ? ['--review',JSON.stringify(verdict)] : [])],agent+' fixture complete');
 fs.writeFileSync(${JSON.stringify(path.join(root, `${agent}-report.json`))},JSON.stringify({identity,forbidden,handoff,mcp}));
});
process.on('exit',()=>cleanup?.());
})().catch(error=>{console.error(error);process.exit(1);});
`,
      { mode: 0o700 },
    );
  }
  const sshCalls = path.join(root, "ssh-calls");
  const launchCalls = path.join(root, "ssh-launch-calls");
  await writeFile(launchCalls, "");
  const snapshots = async () =>
    (await readFile(launchCalls, "utf8")).split("snapshot-complete\n").length - 1;
  const verifiedCompletion = async (before) => {
    // Main reads evidence, then independently revalidates it before sending stop.
    for (const count of [1, 2]) await expect.poll(snapshots).toBeGreaterThanOrEqual(before + count);
  };
  await writeFile(
    path.join(bin, "ssh"),
    `#!${process.execPath}
const {spawn} = require('node:child_process'), {appendFileSync}=require('node:fs');
const args=process.argv.slice(2), split=args.indexOf('--');
if(args[split+1]!=='fleet-worker') process.exit(2);
appendFileSync(${JSON.stringify(sshCalls)},'ssh\\n');
if(args.at(-1)==='uname -s; uname -m') {process.stdout.write(require('node:os').type()+'\\n'+(process.arch==='x64'?'x86_64':process.platform==='darwin'?'arm64':'aarch64')+'\\n');process.exit(0);}
const {RemoteFrames}=require(${JSON.stringify(path.resolve("build/shared/remote-host-protocol.js"))});
const frames=new RemoteFrames(), responses=new RemoteFrames(); let operation;
const sent=bytes=>frames.push(bytes,message=>{if(message.type==='manage')operation=message.operation; if(message.type.startsWith('agent-'))appendFileSync(${JSON.stringify(launchCalls)},message.type+'\\n');});
const received=bytes=>responses.push(bytes,message=>{if(message.type==='managed' && operation==='snapshot-worktree')appendFileSync(${JSON.stringify(launchCalls)},message.result.ok?'snapshot-complete\\n':'snapshot-refused\\n');});
if (${JSON.stringify(Boolean(reviewLoop))}) {
 // The review scenarios use the already-running real daemon. Bootstrap/upload
 // is covered by the other fleet/host cases; do not hash the SEA on every read.
 const socket=require('node:net').createConnection(${JSON.stringify(path.join(remoteHome, ".foom-host/host-v2.sock"))});
 socket.once('connect',()=>{process.stdout.write('FOOM-READY\\n');process.stdin.on('data',sent);process.stdin.pipe(socket);socket.pipe(process.stdout);});
 socket.on('data',received);socket.on('error',()=>process.exit(1));socket.on('close',()=>process.exit(0));
 process.stdin.once('end',()=>socket.destroy());process.on('SIGTERM',()=>socket.destroy());
} else {
 const child=spawn('/bin/sh',['-c','exec '+args.slice(split+2).join(' ')],{env:{HOME:${JSON.stringify(remoteHome)},PATH:${JSON.stringify(remoteBin)},SHELL:${JSON.stringify(shell)},LANG:'C',FIXTURE_REMOTE_GIT_ROOT:${JSON.stringify(remoteRepo)},FIXTURE_REMOTE_ORIGIN:${JSON.stringify(origin)},FIXTURE_REMOTE_HEAD:'a'.repeat(40)},stdio:['pipe','pipe','pipe']});
 let ready=false, header=Buffer.alloc(0);
 child.stdout.on('data',bytes=>{if(ready){received(bytes);return;} header=Buffer.concat([header,bytes]); const marker=Buffer.from('FOOM-READY\\n'), end=header.indexOf(marker); if(end<0)return; ready=true; received(header.subarray(end+marker.length)); header=Buffer.alloc(0);});
 process.stdin.on('data',bytes=>{if(ready)sent(bytes);});
 process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.stdin.on('error',()=>{});
 process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('close',code=>process.exit(code??1));
}
`,
    { mode: 0o700 },
  );
  const cleanup = fixtureCleanup(context);
  cleanup.audit ??= await auditProcesses(context);
  const artifact = path.resolve("build/remote-host/foom-host");
  const daemon = spawn(artifact, ["--daemon"], {
    env: {
      HOME: remoteHome,
      PATH: remoteBin,
      SHELL: shell,
      FIXTURE_REMOTE_GIT_ROOT: remoteRepo,
      FIXTURE_REMOTE_ORIGIN: origin,
      FIXTURE_REMOTE_HEAD: "a".repeat(40),
    },
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
  // Review transitions exercise durable control/session writes, as in review-loop.test.js.
  const profile = reviewLoop
    ? await createMemoryFixture(context, "foom-remote-review-profile-")
    : path.join(root, "profile");
  const launchOptions = {
    fixture: "agent",
    args: [`--user-data-dir=${profile}`],
    env: {
      HOME: home,
      PATH: bin,
      TEST_FAKE_CREDENTIALS: credentials,
      ...(reviewLoop ? { TEST_FORGE_STATE: forgeState } : {}),
    },
  };
  const { app, page, parent } = await launchTrustedParent(context, {
    repo,
    credentials,
    options: launchOptions,
  });
  restartTiming("parent launched");
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
  for (const agent of agents)
    assert.equal(worker.agents.find((entry) => entry.id === agent).state, "ready");
  assert.ok(sessions.hosts.some((host) => host.host === null));
  let tree;
  if (agents.includes("codex") && !reviewLoop) {
    tree = await call("create_worktree", {
      host: "fleet-worker",
      branch: "missing-agent",
      idempotencyKey: "missing-tree",
    });
    assert.equal(tree.status, "succeeded", JSON.stringify(tree));
    await rename(path.join(remoteBin, "codex"), path.join(remoteBin, "codex-hidden"));
    await page.evaluate(() => window.desktop.hosts({ action: "refresh", host: "fleet-worker" }));
    // Background forge inspections may use SSH; refused launch must send no
    // agent preparation/start frame. Record types only, never credentials or prompts.
    const before = await readFile(launchCalls, "utf8");
    const missing = await call("launch", {
      host: "fleet-worker",
      worktreeId: tree.resultId,
      agent: "codex",
      idempotencyKey: "missing-agent",
    });
    assert.equal(missing.status, "failed");
    assert.equal(missing.reason, "remote_agent_unavailable");
    assert.equal(await readFile(launchCalls, "utf8"), before);
    await rename(path.join(remoteBin, "codex-hidden"), path.join(remoteBin, "codex"));
    await page.evaluate(() => window.desktop.hosts({ action: "refresh", host: "fleet-worker" }));
  }
  for (const agent of agents) {
    const checkout =
      agent === "codex" && tree
        ? tree
        : await call("create_worktree", {
            host: "fleet-worker",
            ...(reviewLoop ? { pullRequest: 340 } : { branch: `child-${agent}` }),
            idempotencyKey: `tree-${agent}`,
          });
    assert.equal(checkout.status, "succeeded", JSON.stringify(checkout));
    const launched = await call("launch", {
      host: "fleet-worker",
      worktreeId: checkout.resultId,
      agent,
      prompt: "Complete the fixture task",
      ...(reviewLoop ? { review: { agent: "codex", rounds: 3 } } : {}),
      idempotencyKey: `launch-${agent}`,
    });
    assert.equal(launched.status, "succeeded", agent + ": " + JSON.stringify(launched));
    assert.deepEqual(launched.placement, { kind: "remote", host: "fleet-worker" });
    assert.ok((await readFile(launchCalls, "utf8")).includes("agent-open\n"));
    assert.ok((await readFile(launchCalls, "utf8")).includes("agent-start\n"));
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(path.join(root, `${agent}-launch.json`), "utf8"));
        } catch {
          return null;
        }
      })
      .not.toBeNull()
      .catch(async (error) => {
        const { state } = await call("session_state", { id: launched.resultId });
        console.error("Remote fleet launch readiness", JSON.stringify({ agent, state }));
        throw error;
      });
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
    if (!reviewLoop && agent === agents[0])
      await copyRemoteBranch(
        app,
        page,
        agent === "codex" && tree ? "missing-agent" : `child-${agent}`,
      );
    assert.equal(
      (await call("session_state", { id: launched.resultId, host: "fleet-worker" })).host,
      "fleet-worker",
    );
    if (reviewLoop) {
      // Board discovery also makes API calls. Observe the bound child status
      // request before waiting for its validated publication.
      await expect
        .poll(async () => (await readFile(forgeCalls, "utf8")).includes("remote-status\n"))
        .toBe(true);
      await expect
        .poll(
          async () =>
            (await call("session_state", { id: launched.resultId })).pullRequest?.requiredChecks,
        )
        .toBe("success")
        .catch(async (error) => {
          const { state, review, pullRequest } = await call("session_state", {
            id: launched.resultId,
          });
          console.error(
            "Remote review initial observation",
            JSON.stringify({
              state,
              review,
              pullRequest,
              forgeCalls: await readFile(forgeCalls, "utf8"),
            }),
          );
          throw error;
        });
    }
    const initialSnapshots = reviewLoop ? await snapshots() : 0;
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
      else if (agent === "copilot") assert.ok(record.args.includes("--additional-mcp-config"));
      else if (agent === "pi") {
        assert.ok(record.args.includes("--extension"));
        assert.deepEqual(Object.keys(record.attachment.toolExposure).sort(), [
          "handoff",
          "manual",
          "whoami",
        ]);
      } else assert.equal(record.attachment.type, "local");
    }
    assert.ok(!JSON.stringify(report).includes(parentId));
    assert.ok(!JSON.stringify(report).includes(launched.resultId));
    await expect
      .poll(async () => (await call("read_handoff", { id: launched.resultId })).summary)
      .toBe(`${agent} fixture complete`);
    if (reviewLoop) {
      await verifiedCompletion(initialSnapshots);
      await expect
        .poll(async () => (await call("session_state", { id: launched.resultId })).state)
        .toBe("exited");
      let previous = record;
      const aliases = new Set([JSON.parse(report.identity.output).alias]);
      for (const stage of reviewLoop === "clean" ? ["review-1"] : ["review-1", "fix"]) {
        // Main snapshots the exited checkout before preparing the next launch.
        await expect
          .poll(async () => (await call("session_state", { id: launched.resultId })).review?.phase)
          .toBe(stage === "fix" ? "fixing" : "reviewing");
        const opens = (await readFile(launchCalls, "utf8")).split("agent-open\n").length;
        await expect
          .poll(async () => {
            const current = JSON.parse(
              await readFile(path.join(root, `${agent}-launch.json`), "utf8"),
            );
            return (
              current.pid !== previous.pid ||
              (await readFile(launchCalls, "utf8")).split("agent-open\n").length > opens
            );
          })
          .toBe(true);
        await expect
          .poll(async () => {
            const current = JSON.parse(
              await readFile(path.join(root, `${agent}-launch.json`), "utf8"),
            );
            return (
              current.pid !== previous.pid && (stage === "fix" ? current.resumed : current.reviewer)
            );
          })
          .toBe(true)
          .catch(async (error) => {
            const latest = JSON.parse(
              await readFile(path.join(root, `${agent}-launch.json`), "utf8"),
            );
            const rows = (await call("sessions")).sessions;
            console.error(
              "Remote review progression",
              JSON.stringify({
                stage,
                launch: { pid: latest.pid, reviewer: latest.reviewer, resumed: latest.resumed },
                launchFrames: await readFile(launchCalls, "utf8"),
                sessions: rows.map(({ id, state, review, handoff, pullRequest }) => ({
                  id,
                  state,
                  review,
                  handoff,
                  pullRequest,
                })),
              }),
            );
            throw error;
          });
        await expect
          .poll(async () =>
            (await call("sessions")).sessions.some(
              (row) =>
                row.state !== "exited" &&
                row.review?.waiting === false &&
                (stage === "fix"
                  ? row.id === launched.resultId
                  : row.id !== launched.resultId && row.review?.phase === "reviewing"),
            ),
          )
          .toBe(true);
        const current = JSON.parse(await readFile(path.join(root, `${agent}-launch.json`), "utf8"));
        const state = (await call("sessions")).sessions;
        const participant =
          stage === "fix"
            ? launched.resultId
            : state.find(
                (row) =>
                  row.id !== launched.resultId &&
                  row.review?.phase === "reviewing" &&
                  row.state !== "exited",
              )?.id;
        assert.ok(participant, JSON.stringify(state));
        assert.ok(!JSON.stringify(current).includes(participant));
        assert.ok(!JSON.stringify(current).includes(parentId));
        assert.ok(!JSON.stringify(current).includes(parent.controlToken));
        assert.equal(current.cwd, record.cwd);
        if (stage === "fix") {
          assert.ok(current.args.at(-1).includes("Quoted review notes"));
          assert.ok(current.args.includes("author-conversation"));
        }
        await rm(path.join(root, `${agent}-report.json`));
        const completedSnapshots = await snapshots();
        await call("send_keys", {
          id: participant,
          keys: ["1"],
          idempotencyKey: `report-${stage}`,
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
        const next = JSON.parse(await readFile(path.join(root, `${agent}-report.json`), "utf8"));
        const identity = JSON.parse(next.identity.output);
        assert.equal(identity.role, "child");
        assert.deepEqual(identity.capabilities.sort(), ["handoff", "manual", "whoami"]);
        assert.ok(!aliases.has(identity.alias));
        aliases.add(identity.alias);
        assert.equal(JSON.parse(next.forbidden.output).error, "phase_2_restricted");
        assert.equal(next.handoff.code, 0);
        if (stage !== "fix") {
          await verifiedCompletion(completedSnapshots);
          await expect
            .poll(async () => (await call("session_state", { id: participant })).state)
            .toBe("exited")
            .catch(async (error) => {
              const { state, review, pullRequest, handoff } = await call("session_state", {
                id: participant,
              });
              console.error(
                "Remote reviewer completion",
                JSON.stringify({
                  state,
                  review,
                  pullRequest,
                  handoff,
                  launchFrames: await readFile(launchCalls, "utf8"),
                }),
              );
              throw error;
            });
        }
        assert.ok(!JSON.stringify(next).includes(participant));
        previous = current;
      }
      await expect
        .poll(async () => (await call("session_state", { id: launched.resultId })).review?.phase)
        .toBe(reviewLoop === "clean" ? "clean" : "waiting-on-parent");
      assert.equal((await call("session_state", { id: launched.resultId })).review.round, 1);
      return;
    }
    if (restart && agent === "codex") {
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
    if (["copilot", "pi", "opencode"].includes(agent)) {
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
      assert.ok(resumed.args.includes(agent === "copilot" ? "--resume" : "--session"));
      assert.ok(resumed.cwd === record.cwd);
      await call("stop", { id: launched.resultId, idempotencyKey: `stop-resumed-${agent}` });
      await expect
        .poll(async () => (await call("session_state", { id: launched.resultId })).state)
        .toBe("exited");
    }
    if (["pi", "opencode"].includes(agent)) {
      const file =
        agent === "pi" ? record.args[record.args.indexOf("--extension") + 1] : record.hookFile;
      await expect
        .poll(async () => {
          try {
            await stat(file);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
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
  if (!restart) return;
  restartTiming("live child reported");
  assert.ok(persistent);
  const unused = await call("create_worktree", {
    host: "fleet-worker",
    branch: "unused-after-restart",
    idempotencyKey: "unused-before-restart",
  });
  assert.equal(unused.status, "succeeded", JSON.stringify(unused));
  restartTiming("unused checkout created");
  const foreignTree = path.join(folder, ".foom-worktree-other-profile");
  const untaggedTree = path.join(folder, ".foom-worktree-untagged");
  await mkdir(foreignTree, { mode: 0o700 });
  await mkdir(untaggedTree, { mode: 0o700 });
  const {
    writeWorktreeProvenance,
  } = require("../../build/terminal-host/remote/worktree-provenance.js");
  await writeWorktreeProvenance("b".repeat(32), remoteRepo, foreignTree, origin);
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
  restartTiming("first hub quit");
  const restarted = await launchApp(context, { ...launchOptions, fixture: "restored" }).finally(
    () => {
      cleanup.apps.splice(cleanup.apps.indexOf(closeDaemon), 1);
      cleanup.apps.push(closeDaemon);
    },
  );
  const restored = await boardPage(restarted);
  restartTiming("restored board ready");
  // Inventory recovers an unused checkout without any session or orchestration grant.
  const restoredTrees = await restored.evaluate(
    (repository) => window.desktop.worktrees(repository),
    repo,
  );
  const recovered = restoredTrees.find((tree) => tree.branch === "unused-after-restart");
  assert.ok(recovered);
  assert.equal(recovered.host, "fleet-worker");
  assert.ok(!restoredTrees.some((tree) => /other-profile|untagged/.test(tree.branch || "")));
  restartTiming("checkout inventory recovered");
  const hostState = await restored.evaluate(() => window.desktop.hosts({ action: "list" }));
  restartTiming("host inventory refreshed");
  assert.equal(hostState.hosts.find((host) => host.host === "fleet-worker").foreignWorktrees, 2);
  assert.ok(
    !(await restored.evaluate(() => window.desktop.workspace())).terminals.some(
      (row) => row.worktree === recovered.path,
    ),
  );
  for (const theme of ["eclipse-light", "eclipse-dark"]) {
    await restored.evaluate(
      (interfaceTheme) => window.desktop.saveSetup({ interfaceTheme }),
      theme,
    );
    await restored.screenshot({ path: path.resolve(`test-results/941-recovered-${theme}.png`) });
  }

  // The parent must complete its new launch before child re-grant can finish.
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(`${credentials}.app`, "utf8")).controlToken !==
        parent.controlToken,
    )
    .toBe(true);
  restartTiming("parent credentials renewed");
  const newParent = JSON.parse(await readFile(`${credentials}.app`, "utf8"));
  await expect
    .poll(
      async () =>
        (await restored.evaluate(() => window.desktop.workspace())).terminals.find(
          (row) => row.id === persistent.id,
        )?.orchestration?.role,
    )
    .toBe("child")
    .catch(async (error) => {
      console.error(
        "Remote restore state:",
        await restored.evaluate(() => window.desktop.workspace()),
      );
      throw error;
    });
  restartTiming("child authority restored");
  await expect
    .poll(
      async () =>
        (await restored.evaluate(() => window.desktop.workspace())).terminals.find(
          (row) => row.id === persistent.id,
        )?.dormant,
    )
    .toBe(false);
  await copyRemoteBranch(restarted, restored, "missing-agent");
  assert.equal(
    JSON.parse(await readFile(path.join(root, "codex-launch.json"), "utf8")).pid,
    persistent.pid,
  );
  await expect
    .poll(async () =>
      (await restored.evaluate((id) => window.desktop.tail(id, 40), persistent.id)).join("\n"),
    )
    .toContain("REMOTE_CODEX_READY");
  restartTiming("child replay attached");
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
  restartTiming("fresh restricted authority verified");
  await restoredCall("stop", { id: persistent.id, idempotencyKey: "stop-after-restart" });
  await expect
    .poll(async () => (await restoredCall("session_state", { id: persistent.id })).state)
    .toBe("exited");
  await restored.evaluate(
    ({ repository, worktree }) =>
      window.desktop.sidebarCommand({ kind: "launch", repository, worktree, run: "shell" }),
    { repository: repo, worktree: recovered.path },
  );
  const expectedCheckout = Object.entries(JSON.parse(await readFile(gitState, "utf8"))).find(
    ([, branch]) => branch === "unused-after-restart",
  )?.[0];
  assert.ok(expectedCheckout);
  const humanShell = (await restored.evaluate(() => window.desktop.workspace())).terminals.find(
    (row) => row.worktree === recovered.path,
  );
  assert.ok(humanShell);
  assert.equal(humanShell.orchestration, undefined);
  assert.deepEqual(humanShell.placement, { kind: "remote", host: "fleet-worker" });
  await restored.locator(".board-row[data-kind='shell']").click();
  await expect(
    restored.locator(".terminal-tile[data-kind='shell'] .xterm-helper-textarea"),
  ).toBeFocused();
  await restored.keyboard.type("pwd");
  await restored.keyboard.press("Enter");
  await expect
    .poll(async () =>
      (await restored.evaluate((id) => window.desktop.tail(id, 40), humanShell.id)).join(""),
    )
    .toContain(expectedCheckout);
  await restored.keyboard.type("exit");
  await restored.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await restored.evaluate(() => window.desktop.workspace())).terminals.find(
          (row) => row.id === humanShell.id,
        )?.exited,
    )
    .toBe(true);
  await restored.evaluate(
    (id) => window.desktop.sidebarCommand({ kind: "close", id }),
    humanShell.id,
  );
  assert.ok(
    (await restored.evaluate((repository) => window.desktop.worktrees(repository), repo)).some(
      (tree) => tree.path === recovered.path,
    ),
  );
  const deleting = restored.evaluate(
    ({ repository, worktree }) =>
      window.desktop.sidebarCommand({ kind: "remove-worktree", repository, worktree }),
    { repository: repo, worktree: recovered.path },
  );
  const review = await confirmationPage(restarted);
  await expect(
    review.getByRole("heading", { name: "Remove worktree?", exact: true }),
  ).toBeVisible();
  await expect(review.getByText(`fleet-worker:${expectedCheckout}`, { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Remove worktree", exact: true }).click();
  await deleting;
  assert.ok(
    !(await restored.evaluate((repository) => window.desktop.worktrees(repository), repo)).some(
      (tree) => tree.path === recovered.path,
    ),
  );
  assert.ok(
    !Object.values(JSON.parse(await readFile(gitState, "utf8"))).includes("unused-after-restart"),
  );
  assert.ok((await stat(foreignTree)).isDirectory());
  assert.ok((await stat(untaggedTree)).isDirectory());
  await openSettingsScreen(restored);
  await restored
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Hosts", exact: true })
    .click();
  await expect(restored.getByText("2 other worktrees", { exact: true })).toBeVisible();
  for (const theme of ["eclipse-light", "eclipse-dark"]) {
    await restored.evaluate(
      (interfaceTheme) => window.desktop.saveSetup({ interfaceTheme }),
      theme,
    );
    await restored.screenshot({ path: path.resolve(`test-results/941-hosts-${theme}.png`) });
  }
}

const fleetOptions = { skip: process.platform === "win32", timeout: deadline(90000) };
for (const agent of ["codex", "copilot", "agy"]) {
  test(
    `registered-host ${agent} lifecycle uses host inventory and restricted child tools`,
    fleetOptions,
    (context) => remoteFleet(context, [agent]),
  );
}
test(
  "registered-host restart reattaches a live child with screen replay and fresh restricted authority",
  fleetOptions,
  (context) => remoteFleet(context, ["codex"], true),
);

test(
  "registered-host Pi and OpenCode consume private extensions, context, MCP and resume attachments",
  fleetOptions,
  (context) => remoteFleet(context, ["pi", "opencode"]),
);

test("registered-host clean reviewer completes with restricted identity", fleetOptions, (context) =>
  remoteFleet(context, ["codex"], false, "clean"),
);
test(
  "registered-host review findings resume the author with fresh restricted identity",
  fleetOptions,
  (context) => remoteFleet(context, ["codex"], false, "findings"),
);
