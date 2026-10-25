const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  assertAccessible,
  boardPage,
  confirmationPage,
  launchApp,
  openSettingsScreen,
  removeAfterApps,
} = require("./harness.js");

test("config probe CLI drives only scratch fixture screens and the user can interrupt its tile", {
  timeout: deadline(60_000),
}, async (context) => {
  const { chmod, copyFile } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-config-probe-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  await Promise.all([bin, home].map((directory) => mkdir(directory)));
  const executable = path.join(
    bin,
    process.platform === "win32" ? "fixturecode.exe" : "fixturecode",
  );
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  const attachment = path.join(root, "attachment.json");
  const script = path.join(root, "agent.cjs");
  const details = path.join(root, "launch.json");
  const result = path.join(root, "driver.json");
  const driver = path.join(root, "driver.cjs");
  await writeFile(
    script,
    `
const fs = require('node:fs');
const path = require('node:path');
const pluginIndex=process.argv.indexOf('--plugin-dir');
if(pluginIndex!==-1) {
  const directory=process.argv[pluginIndex+1];
  const plugin=JSON.parse(fs.readFileSync(path.join(directory,'plugin.json'),'utf8'));
  const hooks=JSON.parse(fs.readFileSync(path.join(directory,'hooks/hooks.json'),'utf8'));
  const command=hooks.hooks.Stop[0].command;
  if(plugin.name!=='foom-observer' || typeof command!=='string' || command.includes('{observer') || !fs.existsSync(path.join(directory,'lifecycle',process.platform==='win32'?'observer.ps1':'observer.sh'))) throw Error('Invalid generated plugin attachment');
  fs.writeFileSync(${JSON.stringify(attachment)},JSON.stringify({directory,generatedCommand:true,nestedFile:true,controlUrl:process.env.FOOM_CONTROL_URL,controlToken:process.env.FOOM_CONTROL_TOKEN}));
  process.stdout.write('HOOKS_ATTACHED\\r\\n');
}
fs.writeFileSync(${JSON.stringify(details)}, JSON.stringify({cwd:process.cwd(),hookProtocol:process.env.FOOM_HOOK_PROTOCOL,hookChannels:JSON.parse(process.env.FOOM_HOOK_CHANNELS),env:Object.keys(process.env).filter(key => /^FOOM_/i.test(key)),args:process.argv.slice(2)}));
process.stdout.write(Array.from({length:40},(_,i) => 'SCROLLBACK_SECRET_'+i+'\\r\\n').join(''));
process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[H\\x1b]0;Fixture probe title\\x07Trust this folder? (y/n)');
let trusted=false;
process.stdin.setRawMode(true);
process.stdin.on('data', data => {
  const value=data.toString();
  if(!trusted && value.includes('\\r')) { trusted=true; process.stdout.write('\\x1b[2J\\x1b[HFixture ready'); return; }
  if(value.includes('\\t')) process.stdout.write('\\r\\nKEY:TAB');
  const text=value.split('\\t').join('').trim();
  if(text) process.stdout.write('\\r\\nRECEIVED:'+text);
});
process.stdin.resume();
`,
  );
  const v2 = JSON.parse(
    await readFile(path.join(__dirname, "../fixtures/agent-plugins-v2/copilot.json"), "utf8"),
  );
  const manifest = {
    ...v2,
    id: "fixturecode",
    name: "FixtureCode",
    badge: "CP",
    executables: ["fixturecode"],
    discovery: { facts: [] },
    launch: {
      order: [
        "arguments",
        "resume",
        "defaults",
        "display",
        "guidance",
        "hooks",
        "mcp",
        "tools",
        "prompt",
      ],
      arguments: { arguments: [script] },
    },
    files: [],
    reservedArguments: [],
    bypassArguments: [],
    bypassEnvironment: [],
    conversation: { resumePin: "requested-on-paste", restoreControl: false },
    resumePaste: [],
    attention: { minimumEngineVersion: 1, rules: [] },
    execution: { completion: "attached", completionChannels: [] },
  };
  delete manifest.hooks;
  delete manifest.setup;
  delete manifest.health;
  const draft = path.join(root, "draft", "fixturecode.json");
  await writeFile(
    driver,
    `
const fs=require('node:fs'); const {execFileSync}=require('node:child_process');
const cli=process.platform==='win32'?'foom.exe':'foom';
const writeResult=(target,text) => { fs.writeFileSync(target+'.tmp',text); fs.renameSync(target+'.tmp',target); };
const call=(...args) => JSON.parse(execFileSync(cli,['agent','probe',...args],{encoding:'utf8',env:process.env})).result;
// This deterministic fixture agent receives the shipped guide/starter, not a prepared target manifest.
const guide=fs.readFileSync('AGENTS.md','utf8');
const blocks=[...guide.matchAll(/\`\`\`json\\n([\\s\\S]*?)\\n\`\`\`/g)].map(match=>JSON.parse(match[1]));
const pluginArguments=blocks.find(block=>Array.isArray(block) && block[0]==='--plugin-dir');
const files=blocks.find(block=>Array.isArray(block) && block[0]?.scope==='launch');
if(!pluginArguments || !files || !guide.includes('answer the probe') || !guide.includes('Stop')) throw Error('Guide lacks probe/plugin instructions');
const target=JSON.parse(fs.readFileSync('examples/agent.json','utf8'));
Object.assign(target,{id:'fixturecode',name:'FixtureCode',badge:'CP',executables:['fixturecode'],launch:{order:target.launch.order,arguments:{arguments:[${JSON.stringify(script)}]}},conversation:{resumePin:'requested-on-paste',restoreControl:false},attention:{minimumEngineVersion:1,rules:[]},resumePaste:[]});
const channel=target.hooks.channels[0]; channel.arguments=pluginArguments; channel.observer.transport='stdin'; channel.when={all:[{field:'hooksEnabled',op:'eq',value:true}]};
target.files=files.map(file=>({...file,when:channel.when}));
target.reservedArguments.push({flag:'--plugin-dir',forms:['exact','equals','separate']});
fs.mkdirSync(require('node:path').dirname(${JSON.stringify(draft)}),{recursive:true});
fs.writeFileSync(${JSON.stringify(draft)},JSON.stringify(target));
execFileSync(cli,['config','validate',${JSON.stringify(draft)}],{encoding:'utf8',env:process.env});
const probe=call('start','fixturecode','--manifest',${JSON.stringify(draft)}).probe;
writeResult(${JSON.stringify(result)},JSON.stringify({probe,validationPasses:1}));
console.log('DRIVER_READY');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  try {
    if(line==='enter') {
      call('keys',probe,'enter'); console.log('TRUST_ANSWERED');
    } else if(line==='screen') {
      call('wait',probe,'--quiet','0.1');
      const before=call('screen',probe); const state=call('state',probe); const saved=call('screen',probe,'--save','other');
      call('send',probe,'yes'); call('keys',probe,'tab'); call('wait',probe,'--quiet','0.1');
      writeResult(${JSON.stringify(result)},JSON.stringify({probe,validationPasses:1,before,state,saved,after:call('screen',probe)}));
      console.log('SCREEN_READY');
    } else if(line==='install') {
      fs.copyFileSync(${JSON.stringify(draft)},require('node:path').join(process.cwd(),'agents/fixturecode.json')); console.log('MANIFEST_INSTALLED');
    } else if(line==='rules') {
      const rules=JSON.parse(execFileSync(cli,['config','test-rules','fixturecode','--json'],{encoding:'utf8',env:process.env})).result;
      execFileSync(cli,['config','validate','.'],{encoding:'utf8',env:process.env});
      const previous=JSON.parse(fs.readFileSync(${JSON.stringify(result)},'utf8'));
      writeResult(${JSON.stringify(result)},JSON.stringify({...previous,rules}));
    } else if(line==='hold') {
      const settings=JSON.parse(fs.readFileSync('settings.json','utf8'));
      settings.agentArguments={claude:[],codex:[],agy:[],...settings.agentArguments,fixturecode:['--fixture']};
      fs.writeFileSync('settings.json',JSON.stringify(settings));
      execFileSync(cli,['config','validate','settings.json'],{encoding:'utf8',env:process.env});
      const status=JSON.parse(execFileSync(cli,['config','status','--json'],{encoding:'utf8',env:process.env})).result;
      const previous=JSON.parse(fs.readFileSync(${JSON.stringify(result)},'utf8'));
      writeResult(${JSON.stringify(result)},JSON.stringify({...previous,status}));
      if(status.pending) console.log('Settings held: '+status.pending.detail+'. Choose Allow / Keep it on in Foom config.');
    } else if(line==='exit') {process.exit(0);
    } else if(line==='restart') {
      const second=call('start','fixturecode','--manifest',${JSON.stringify(draft)}).probe;
      let screen;
      const deadline=Date.now()+${deadline(5000)};
      do { call('wait',second,'--quiet','0.1'); screen=call('screen',second); } while(!screen.lines.join('\\n').includes('Trust this folder?') && Date.now()<deadline);
      const launch=JSON.parse(fs.readFileSync(${JSON.stringify(details)},'utf8'));
      const stopped=call('stop',second);
      const previous=JSON.parse(fs.readFileSync(${JSON.stringify(result)},'utf8'));
      writeResult(${JSON.stringify(result)},JSON.stringify({...previous,second:{probe:second,screen,launch,...stopped}}));
      console.log('SECOND_STOPPED');
    }
  } catch(error) {writeResult(${JSON.stringify(result)},JSON.stringify({error:error.message}));console.error(error.message);}
});
`,
  );
  const agents = path.join(home, ".foom/config/agents");
  await mkdir(agents, { recursive: true });
  await copyFile(
    process.execPath,
    path.join(bin, process.platform === "win32" ? "foom-config-driver.exe" : "foom-config-driver"),
  );
  await writeFile(
    path.join(agents, "config-driver.json"),
    JSON.stringify({
      ...manifest,
      id: "config-driver",
      name: "Config driver",
      executables: ["foom-config-driver"],
      launch: { ...manifest.launch, arguments: { arguments: [driver] } },
    }),
  );
  const app = await launchApp(context, {
    fixture: "running-shell",
    shell: "hidden",
    home,
    probeWaitingMs: deadline(1000),
    env: { HOME: home, PATH: bin },
  });
  const page = await boardPage(app);
  await page.evaluate(() =>
    window.desktop.sidebarCommand({ kind: "config-launch", run: "config-driver" }),
  );
  const configId = await page.evaluate(
    async () => (await window.desktop.workspace()).terminals.find((row) => row.config).id,
  );
  await expect
    .poll(async () =>
      (await page.evaluate((id) => window.desktop.tail(id, 24), configId)).join("\n"),
    )
    .toContain("DRIVER_READY");
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.workspace())).terminals.filter((row) => row.probe)
          .length,
    )
    .toBe(1);
  const probeRow = page.locator(".config-dock .board-row").filter({ hasText: "Probe" });
  await expect(probeRow).toBeVisible();
  await expect(page.getByRole("note")).toBeVisible();
  await expect(page.getByRole("note")).toHaveText(
    "Runs the real CLI on your account. May use credits.",
  );
  await expect(page.locator(".probe-driver")).toHaveText("Probe · config-driver");
  const probeTile = page.locator(".terminal-tile").filter({ has: page.locator(".probe-driver") });
  await expect(probeTile.locator(".tile-attention")).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.workspace())).terminals.find(
          (row) => row.id === configId,
        )?.state?.reason,
    )
    .toBe("Probe waiting");
  await expect(probeTile.locator(".tile-attention")).toHaveCount(0);
  assert.notEqual(
    (await page.evaluate(() => window.desktop.workspace())).terminals.find((row) => row.probe)
      ?.state?.state,
    "needs_input",
  );
  await page.screenshot({ path: "test-results/config-probe.png", animations: "disabled" });
  await page.evaluate((id) => window.desktop.input(id, "enter\r"), configId);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.workspace())).terminals.find(
          (row) => row.id === configId,
        )?.state?.reason ?? "",
    )
    .not.toBe("Probe waiting");
  await expect(page.locator(".tile-name").filter({ hasText: "fixturecode" })).toBeVisible();
  await expect
    .poll(async () =>
      (await page.evaluate((id) => window.desktop.tail(id, 24), configId)).join("\n"),
    )
    .toContain("DRIVER_READY");
  await page.evaluate((id) => window.desktop.input(id, "screen\r"), configId);
  await expect
    .poll(async () => {
      try {
        const value = JSON.parse(await readFile(result, "utf8"));
        return value.after?.lines.join("\n") ?? value.error ?? "waiting for driver";
      } catch {
        return "";
      }
    })
    .toContain("RECEIVED:yes");
  await expect
    .poll(async () => JSON.parse(await readFile(result, "utf8")).after?.lines.join("\n") ?? "")
    .toContain("KEY:TAB");
  const record = JSON.parse(await readFile(result, "utf8"));
  assert.equal(record.validationPasses, 1);
  assert.equal(record.before.title, "Fixture probe title");
  assert.equal(record.saved.capture, "captures/fixturecode/other-1.json");
  const savedCapture = JSON.parse(
    await readFile(path.join(home, ".foom/config", record.saved.capture), "utf8"),
  );
  assert.deepEqual(savedCapture.lines, record.before.lines);
  assert.equal(savedCapture.title, record.before.title);
  assert.equal(savedCapture.cols, record.before.cols);
  assert.equal(savedCapture.rows, record.before.rows);
  assert.equal(savedCapture.lines.length, savedCapture.rows);
  assert.ok(savedCapture.agentVersion.length > 0);

  assert.ok(!record.before.lines.join("\n").includes("SCROLLBACK_SECRET"));
  assert.equal(record.state.state, "working");
  const launch = JSON.parse(await readFile(details, "utf8"));
  assert.notEqual(launch.cwd, home);
  assert.notEqual(launch.cwd, path.join(home, ".foom/config"));
  assert.deepEqual(
    launch.env.sort(),
    [
      "FOOM_CHANNEL_lifecycle",
      "FOOM_CONTROL_TOKEN",
      "FOOM_HOOK_URL",
      "FOOM_HOOK_PROTOCOL",
      "FOOM_HOOK_CHANNELS",
      "FOOM_SESSION",
      "FOOM_TOKEN",
    ].sort(),
  );
  assert.equal(launch.hookProtocol, "1");
  assert.deepEqual(launch.hookChannels, []);
  assert.equal(launch.args[0], "--plugin-dir");
  assert.ok(path.isAbsolute(launch.args[1]));
  await page
    .getByRole("button", {
      name: "Actions for fixturecode · Probe in Foom config",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Stop fixturecode", exact: true }).click();
  const confirmStop = page.getByRole("menuitem", { name: "Click again to stop", exact: true });
  await expect(confirmStop).toBeVisible();
  // The existing Stop confirmation requires at least 300 ms between clicks.
  await page.waitForTimeout(310);
  await confirmStop.click();
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.workspace())).terminals.some((row) => row.probe),
    )
    .toBe(false);
  await expect
    .poll(async () => {
      try {
        await require("node:fs/promises").access(launch.cwd);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  await page.evaluate((id) => window.desktop.input(id, "restart\r"), configId);
  await expect
    .poll(async () => JSON.parse(await readFile(result, "utf8")).second?.stopped ?? false)
    .toBe(true);
  const second = JSON.parse(await readFile(result, "utf8")).second;
  assert.notEqual(second.probe, record.probe);
  assert.notEqual(second.launch.cwd, launch.cwd);
  assert.ok(second.screen.lines.join("\n").includes("Trust this folder?"));
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.workspace())).terminals.some((row) => row.probe),
    )
    .toBe(false);
  await assert.rejects(require("node:fs/promises").access(second.launch.cwd), { code: "ENOENT" });
  await page.evaluate((id) => window.desktop.input(id, "install\r"), configId);
  // Sidebar launch surfaces update while Settings stays closed, without a manual scan.
  await page.locator(".config-gear").click();
  await expect(page.getByRole("menuitem", { name: "Via FixtureCode", exact: true })).toBeVisible();
  assert.ok(
    !JSON.stringify(await page.evaluate(() => window.desktop.appMenu.commands())).includes("via-"),
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Actions for Main checkout", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "FixtureCode", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await require("node:fs/promises").rm(attachment, { force: true });
  await page.evaluate(async () => {
    const repository = (await window.desktop.workspace()).repositories[0].path;
    await window.desktop.sidebarCommand({
      kind: "launch",
      repository,
      worktree: repository,
      run: "fixturecode",
    });
  });
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(attachment, "utf8"));
      } catch {
        return null;
      }
    })
    .toMatchObject({ generatedCommand: true, nestedFile: true });
  const attached = JSON.parse(await readFile(attachment, "utf8"));
  assert.ok(path.isAbsolute(attached.directory));
  assert.notEqual(attached.directory, launch.cwd);
  const mcpUrl = attached.controlUrl.replace("/control/v1", "/mcp");
  let session;
  const mcp = async (message) =>
    fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${attached.controlToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session ? { "Mcp-Session-Id": session, "Mcp-Protocol-Version": "2025-11-25" } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
    });
  const initialized = await mcp({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "fixture", version: "1" },
    },
  });
  assert.equal(initialized.status, 200);
  session = initialized.headers.get("mcp-session-id");
  assert.equal((await mcp({ method: "notifications/initialized" })).status, 202);
  const listed = await (await mcp({ id: 2, method: "tools/list" })).json();
  assert.ok(
    listed.result.tools
      .find((tool) => tool.name === "launch")
      .inputSchema.properties.agent.enum.includes("fixturecode"),
  );
  await page.evaluate((id) => window.desktop.input(id, "rules\r"), configId);
  await expect
    .poll(async () => JSON.parse(await readFile(result, "utf8")).rules ?? null)
    .toMatchObject({
      agentId: "fixturecode",
      passed: true,
      captures: [{ expected: "other", actual: "other", ruleId: null, passed: true }],
    });
  await page.evaluate((id) => window.desktop.input(id, "hold\r"), configId);
  await expect
    .poll(async () =>
      JSON.stringify(
        JSON.parse(await readFile(result, "utf8")).status ??
          JSON.parse(await readFile(result, "utf8")).error ??
          "",
      ),
    )
    .toContain("agentArguments.fixturecode");
  await expect
    .poll(async () =>
      (await page.evaluate((id) => window.desktop.tail(id, 24), configId)).join("\n"),
    )
    .toContain("Settings held:");
  await page.evaluate((id) => window.desktop.input(id, "exit\r"), configId);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.workspace())).terminals.find(
          (row) => row.id === configId,
        )?.exited,
    )
    .toBe(true);
  await expect(page.locator(".config-dock")).toContainText("Needs you");
  await page.locator(".config-gear").click();
  const decision = page.getByRole("region", { name: "Change waiting for approval" });
  await expect(decision).toContainText("agentArguments.fixturecode");
  await page.screenshot({ path: "test-results/config-held-decision.png", animations: "disabled" });
  await decision.getByRole("button", { name: "Allow", exact: true }).click();
  const disclosure = await confirmationPage(app);
  await expect(disclosure.getByRole("alertdialog")).toHaveAccessibleName(
    "Allow agent launch arguments?",
  );
  await disclosure.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(decision).toHaveCount(0);
  await expect(page.locator(".config-dock")).not.toContainText("Needs you");
  assert.deepEqual(
    (await page.evaluate(() => window.desktop.setupState())).settings.agentArguments.fixturecode,
    ["--fixture"],
  );
  // A second held write is kept from Settings; the dock/panel clears in the same turn.
  const settingsFile = path.join(home, ".foom/config/settings.json");
  const settings = JSON.parse(await readFile(settingsFile, "utf8"));
  settings.agentArguments.fixturecode = ["--second-fixture"];
  await writeFile(settingsFile, JSON.stringify(settings));
  await expect(decision).toBeVisible();
  await page.keyboard.press("Escape");
  await openSettingsScreen(page);
  await page
    .getByRole("region", { name: "Settings" })
    .getByRole("button", { name: "Foom config", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Change waiting for approval" })
    .getByRole("button", { name: "Keep it on" })
    .click();
  await expect(page.locator(".config-dock")).not.toContainText("Needs you");
  assert.deepEqual(
    (await page.evaluate(() => window.desktop.setupState())).settings.agentArguments.fixturecode,
    ["--fixture"],
  );
  await assertAccessible(page);
});

test("config guide add-agent workflow verifies captures resume hooks and MCP with fixture CLIs", {
  timeout: deadline(60_000),
}, async (context) => {
  const { chmod, copyFile } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-add-agent-"));
  removeAfterApps(context, root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const agents = path.join(home, ".foom/config/agents");
  await Promise.all([mkdir(bin), mkdir(agents, { recursive: true })]);
  for (const name of ["workflow-agent", "foom-config-driver"]) {
    const target = path.join(bin, process.platform === "win32" ? `${name}.exe` : name);
    await copyFile(process.execPath, target);
    await chmod(target, 0o755);
  }
  for (const name of ["agent", "driver"]) {
    await copyFile(
      path.join(__dirname, `../fixtures/add-agent/${name}.js`),
      path.join(root, `${name}.cjs`),
    );
  }
  const starter = JSON.parse(
    await readFile(path.join(__dirname, "../../src/shared/agent-plugin.example.json"), "utf8"),
  );
  const driver = {
    ...starter,
    id: "config-driver",
    name: "Config driver",
    executables: ["foom-config-driver"],
    discovery: { facts: [] },
    launch: {
      order: starter.launch.order,
      arguments: { arguments: [path.join(root, "driver.cjs"), root, String(deadline(10_000))] },
    },
    conversation: { resumePin: "requested-on-paste", restoreControl: false },
    attention: { minimumEngineVersion: 1, rules: [] },
    execution: { completion: "attached", completionChannels: [] },
  };
  delete driver.hooks;
  await writeFile(path.join(agents, "config-driver.json"), JSON.stringify(driver));
  const app = await launchApp(context, {
    fixture: "agent",
    home,
    env: { HOME: home, PATH: bin },
  });
  const page = await boardPage(app);
  await page.evaluate(() =>
    window.desktop.sidebarCommand({ kind: "config-launch", run: "config-driver" }),
  );
  const resultFile = path.join(root, "result.json");
  await expect
    .poll(
      async () => {
        try {
          return JSON.parse(await readFile(resultFile, "utf8"));
        } catch {
          return null;
        }
      },
      { timeout: deadline(30_000) },
    )
    .not.toBeNull();
  const result = JSON.parse(await readFile(resultFile, "utf8"));
  assert.equal(result.error, undefined, `${result.error} ${result.agentError}`);
  assert.ok(result.metadata.every((text) => text.length > 0));
  assert.equal(result.finalRules.passed, true);
  assert.deepEqual(
    result.finalRules.captures.map(({ expected, actual, ruleId, passed }) => ({
      expected,
      actual,
      ruleId,
      passed,
    })),
    [
      { expected: "blocked", actual: "blocked", ruleId: "permission", passed: true },
      { expected: "idle", actual: "idle", ruleId: "idle", passed: true },
      { expected: "working", actual: "working", ruleId: "working", passed: true },
    ],
  );
  assert.deepEqual(
    result.states.map(({ state }) => state),
    ["working", "needs_input", "working"],
  );
  assert.deepEqual(
    result.states.map(({ ruleId }) => ruleId),
    ["working", "permission", "idle"],
  );
  assert.equal(result.resumed.conversationId, result.states[0].conversationId);
  assert.deepEqual(result.events.mcp, { connected: true, listedTools: true, pinged: true });
  assert.deepEqual(result.validation.problems, []);
  const installed = JSON.parse(await readFile(path.join(agents, "workflow-agent.json"), "utf8"));
  assert.ok(installed.discovery.facts.every(({ enabled }) => enabled === true));
  const capabilities = result.validation.agents.find(({ id }) => id === "workflow-agent");
  assert.deepEqual(capabilities, {
    id: "workflow-agent",
    attention: { rules: 3, channels: ["on"] },
    completion: "observed",
    resume: "Foom-assigned ID",
    mcp: "gated by facts",
    foomTools: "off",
    bypass: { argumentMatchers: 1, environmentVariables: 1 },
    warnings: [],
  });
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.workspace())).terminals.some((row) => row.probe),
    )
    .toBe(false);
});
