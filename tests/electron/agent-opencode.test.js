const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtemp, mkdir, readFile, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { gitSync } = require("../helpers/git.js");
const { fixtureSea } = require("./fixture-sea.js");
const { waitForFixtureRecord } = require("./fixture-records.js");
const {
  boardPage,
  confirmationPage,
  launchApp,
  openSettingsScreen,
  removeAfterApps,
  stopSession,
} = require("./harness.js");
const { deadline, expect } = require("./test-policy.js");

test("bundled OpenCode cards launch isolated event modules and resume assigned conversations", {
  timeout: deadline(60_000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-opencode-fixture-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin"),
    home = path.join(root, "home"),
    profile = path.join(root, "profile"),
    repo = path.join(root, "repo"),
    report = path.join(root, "launch.json");
  await Promise.all([bin, home, repo, profile].map((directory) => mkdir(directory)));
  await writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      version: 1,
      settings: {
        setupComplete: true,
        checkForUpdates: false,
        agentArguments: { claude: [], codex: [], agy: [], opencode: ["--auto"] },
        agentBypassAcknowledged: { claude: false, codex: false, agy: false, opencode: false },
      },
    }),
  );
  gitSync(["init", "-q", "-b", "main", repo]);
  gitSync([
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
  await fixtureSea(
    root,
    path.join(bin, process.platform === "win32" ? "opencode.exe" : "opencode"),
    `
const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')){console.log('opencode v2.0.32');process.exit(0);}
if(process.argv.includes('--help')){console.log('--standalone --session --prompt --auto');process.exit(0);}
(async()=>{
 const args=process.argv.slice(2),id=args[args.indexOf('--session')+1];
 const config=JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG,'utf8'));
 const events=[{id:'evt_1',type:'session.execution.started',data:{sessionID:id}}, {id:'evt_2',type:'permission.asked',data:{sessionID:id}}, {id:'evt_3',type:'permission.replied',data:{sessionID:id}}, {id:'evt_4',type:'session.execution.succeeded',data:{sessionID:id}}];
 const subscribers=[];let index=0;
 process.stdin.setRawMode(true);process.stdin.on('data',()=>{const event=events[index++];if(event)for(const subscriber of subscribers){subscriber.queue.push(event);subscriber.wake?.();}});
 const load=require('node:module').createRequire(${JSON.stringify(path.join(root, "fixture-loader.cjs"))});
 const stops=config.plugins.map(directory=>load(path.join(directory,'index.mjs')).default.setup({event:{async *subscribe({signal}){
   const subscriber={queue:[],wake:undefined};subscribers.push(subscriber);
   while(!signal.aborted){if(!subscriber.queue.length)await new Promise(resolve=>subscriber.wake=resolve);subscriber.wake=undefined;if(subscriber.queue.length)yield subscriber.queue.shift();}
 }}}));
 const mcp=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);const server=Object.values(mcp.mcp.servers)[0];let session;
 const call=async(message)=>{const response=await fetch(server.url,{method:'POST',headers:{Authorization:'Bearer '+process.env.FOOM_CONTROL_TOKEN,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(session?{'Mcp-Session-Id':session,'Mcp-Protocol-Version':'2025-11-25'}:{})},body:JSON.stringify({jsonrpc:'2.0',...message})});session ||= response.headers.get('mcp-session-id');if(response.status===202)return;const body=await response.json();if(body.error)throw Error('MCP refused');return body.result;};
 await call({id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'opencode-fixture',version:'1'}}});await call({method:'notifications/initialized'});const listed=await call({id:2,method:'tools/list'});
 const recordFile=${JSON.stringify(report)};fs.writeFileSync(recordFile+".tmp",JSON.stringify({args,id,configPath:process.env.OPENCODE_CONFIG,plugins:config.plugins,mcp:process.env.OPENCODE_CONFIG_CONTENT,tools:listed.tools.map(tool=>tool.name)}));fs.renameSync(recordFile+".tmp",recordFile);
 console.log('OPENCODE_FIXTURE_READY');
 process.on('SIGTERM',()=>{stops.forEach(stop=>stop());process.exit(0);});
})().catch(error=>{fs.writeFileSync(${JSON.stringify(report + ".error")},String(error));console.error(error);process.exit(1);});
`,
  );
  const agents = path.join(home, ".foom/config/agents");
  await mkdir(agents, { recursive: true });
  await writeFile(
    path.join(agents, "opencode.json"),
    JSON.stringify({
      ...require("../../src/shared/bundled-agents/opencode.json"),
      executables: ["old-custom-opencode"],
      bypassArguments: [],
    }),
  );
  const app = await launchApp(context, {
    fixture: "agent",
    home,
    args: [`--user-data-dir=${profile}`],
    env: { HOME: home, PATH: bin },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, repo);
  const repository = await page.evaluate(() => window.desktop.addRepository());
  const inheritedLaunch = page.evaluate(async (repository) => {
    try {
      await window.desktop.sidebarCommand({
        kind: "launch",
        repository,
        worktree: repository,
        run: "opencode",
      });
      return "launched";
    } catch {
      return "cancelled";
    }
  }, repository.path);
  const migrationDisclosure = await confirmationPage(app);
  await expect(migrationDisclosure.getByRole("alertdialog")).toHaveAccessibleName(
    "Launch OpenCode with bypass?",
  );
  await expect(migrationDisclosure.getByRole("alertdialog")).toContainText("--auto");
  await migrationDisclosure.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await inheritedLaunch, "cancelled");
  assert.equal(
    (await page.evaluate(() => window.desktop.workspace())).terminals.filter(
      (row) => row.agent === "opencode",
    ).length,
    0,
  );
  await assert.rejects(readFile(report));
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const card = page.locator("#agent-card-opencode");
  await expect(card).toContainText("OpenCode");
  await expect(card).toContainText("2.0.32");
  const defaults = card.getByRole("textbox", { name: "OpenCode default arguments" });
  await expect(defaults).toHaveValue("--auto");
  await defaults.fill("--auto\n--model\nreviewed");
  await expect(card.locator(".agent-bypass")).toContainText("Bypass approvals");
  await defaults.blur();
  const disclosure = await confirmationPage(app);
  await expect(disclosure.getByRole("alertdialog")).toHaveAccessibleName(
    "Save bypass defaults for OpenCode?",
  );
  await expect(disclosure.getByRole("alertdialog")).toContainText("--auto");
  await disclosure.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(defaults).toBeEnabled();
  await defaults.fill("");
  await defaults.blur();
  await expect(card.getByRole("switch", { name: "OpenCode", exact: true })).toBeEnabled();
  const configStatus = await page.evaluate(() => window.desktop.configStatus());
  assert.ok(
    configStatus.agentPlugins.some(
      (plugin) => plugin.id === "opencode" && plugin.state === "rejected",
    ),
  );
  await page.keyboard.press("Escape");
  await page.evaluate(
    (repository) =>
      window.desktop.sidebarCommand({
        kind: "launch",
        repository,
        worktree: repository,
        run: "opencode",
      }),
    repository.path,
  );
  const terminal = async () =>
    (await page.evaluate(() => window.desktop.workspace())).terminals.find(
      (row) => row.agent === "opencode",
    );
  await waitForFixtureRecord(report, [report + ".error"], context.signal);
  const row = await terminal();
  assert.ok(row);
  const id = row.id;
  await page.evaluate((id) => window.desktop.input(id, "s"), id);
  await expect.poll(async () => (await terminal())?.execution?.phase).toBe("working");
  const first = JSON.parse(await readFile(report, "utf8"));
  assert.match(first.id, /^ses_[a-f0-9-]{36}$/);
  assert.ok(first.args.includes("--standalone"));
  assert.ok(!first.args.includes("--auto"));
  const config = JSON.parse(first.mcp);
  assert.equal(
    Object.values(config.mcp.servers)[0].headers.Authorization,
    "Bearer {env:FOOM_CONTROL_TOKEN}",
  );
  assert.ok(first.tools.includes("manual"));
  assert.ok(first.tools.includes("whoami"));
  const serverName = Object.keys(config.mcp.servers)[0];
  assert.ok(
    config.permissions.every(
      (rule) => rule.action.startsWith(serverName + "_") && rule.effect === "allow",
    ),
  );
  await page.evaluate((id) => window.desktop.input(id, "b"), id);
  await expect.poll(async () => (await terminal())?.execution?.phase).toBe("blocked");
  await page.evaluate((id) => window.desktop.input(id, "r"), id);
  await expect.poll(async () => (await terminal())?.execution?.phase).toBe("working");
  await page.evaluate((id) => window.desktop.input(id, "c"), id);
  await expect.poll(async () => (await terminal())?.execution?.phase).toBe("idle");
  await stopSession(page, id);
  await expect.poll(async () => (await terminal())?.exited).toBe(true);
  await assert.rejects(readFile(first.configPath));
  await rm(report);
  await page.evaluate((id) => window.desktop.sidebarCommand({ kind: "resume", id }), id);
  await waitForFixtureRecord(report, [report + ".error"], context.signal);
  await page.evaluate((id) => window.desktop.input(id, "s"), id);
  await expect.poll(async () => (await terminal())?.execution?.phase).toBe("working");
  const resumed = JSON.parse(await readFile(report, "utf8"));
  assert.equal(resumed.id, first.id);
  assert.notEqual(resumed.configPath, first.configPath);
});
