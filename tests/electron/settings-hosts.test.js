const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { gzipSync } = require("node:zlib");
const {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  rm,
} = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { gitSync } = require("../helpers/git.js");
const { evidencePath } = require("../helpers/evidence.js");
const { deadline, expect } = require("./test-policy.js");
const {
  boardPage,
  confirmationPage,
  boardCommand,
  fixtureCleanup,
  launchApp,
  quitAndWait,
  openSettingsScreen,
  removeAfterApps,
  assertAccessible,
} = require("./harness.js");

async function captureHosts(app, page, name) {
  const area = page.locator(".hosts-page:visible, .repository-hosts:visible").first();
  if (!(await area.count())) return;
  const original = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const height = await area.evaluate(
    (element) => Math.ceil(element.getBoundingClientRect().height) + 160,
  );
  // Xvfb permits tall review crops; macOS constrains native windows to its display.
  const resizeForCapture = process.platform === "linux" && height > original.height;
  const resize = async (size) => {
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .setContentSize(size.width, size.height);
    }, size);
    await expect
      .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual(size);
  };
  try {
    if (resizeForCapture) await resize({ ...original, height });
    for (const mode of ["light", "dark"]) {
      await page.evaluate(
        (mode) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${mode}` }),
        mode,
      );
      await expect
        .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
        .toBe(mode === "dark");
      await area.screenshot({
        path: evidencePath(
          `${/^(?:1059|1061|1062|1074)\//u.test(name) ? name : `1074/${name}`}-${mode}.png`,
        ),
      });
    }
  } finally {
    if (resizeForCapture) await resize(original);
  }
}

async function assertHostColumns(card) {
  const starts = await card
    .locator(".host-check-row:visible > .host-status > span:last-child")
    .evaluateAll((statuses) => statuses.map((status) => status.getBoundingClientRect().left));
  assert.ok(starts.length >= 4, "Host checks include the code folder row");
  assert.ok(Math.max(...starts) - Math.min(...starts) < 1, JSON.stringify(starts));
}

async function hostsFixture(context, captureEnrollment = false, initialScenario = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "hosts-settings-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const calls = path.join(root, "calls.jsonl");
  await writeFile(calls, "");
  const recipeCalls = path.join(root, "recipes.jsonl");
  const scenario = path.join(root, "scenario.json");
  await writeFile(scenario, JSON.stringify(initialScenario));
  const overflowInfo = path.join(root, "diagnostic-overflow.json");
  const knownHosts = path.join(root, "known_hosts");
  await writeFile(knownHosts, "");
  const cloneReason = path.join(root, "clone-reason");
  await writeFile(cloneReason, "origin-auth");
  await writeFile(recipeCalls, "");
  const recipeFixture = path.join(root, "recipe-fixture.js");
  await writeFile(
    recipeFixture,
    `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(recipeCalls)},JSON.stringify(process.argv.slice(2))+'\\n');process.stdout.write('FIXTURE_RECIPE_COMPLETE\\r\\n');`,
  );
  const bytes = Buffer.from("fixture daemon artifact, never executed");
  const compressed = gzipSync(bytes);
  const sha256 = (data) => createHash("sha256").update(data).digest("hex");
  const platform = process.platform;
  const catalog = path.resolve("build/remote-hosts", `${platform}-${process.arch}`);
  const backups = new Map();
  for (const name of ["foom-host.gz", "manifest.json"]) {
    try {
      backups.set(name, await readFile(path.join(catalog, name)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await mkdir(catalog, { recursive: true });
  const manifest = {
    version: require("../../package.json").version,
    protocol: 3,
    source: gitSync(["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    platform,
    arch: process.arch,
    size: bytes.length,
    sha256: sha256(bytes),
    gzipSize: compressed.length,
    gzipSha256: sha256(compressed),
  };
  await writeFile(path.join(catalog, "foom-host.gz"), compressed);
  await writeFile(path.join(catalog, "manifest.json"), JSON.stringify(manifest));
  // Fixture SSH verifies argv hardening, emulates only bootstrap + closed protocol
  // operations, and never invokes SSH, a shell, Git, an agent or the network.
  await writeFile(
    path.join(bin, "ssh"),
    `#!${process.execPath}
const assert = require('node:assert/strict');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const clientError = (text) => { const index = args.indexOf('-E'); if (index >= 0) appendFileSync(args[index + 1], text); else process.stderr.write(text); };
const current = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(scenario)},'utf8'));
if (args[0] === '-V') { process.stderr.write(current.oldSsh ? 'OpenSSH_8.3p1, fixture' : 'OpenSSH_9.9p1, fixture'); process.exit(0); }
if (args[0] === '-G') { process.stdout.write('hostname fixture-cloud\\nport 22\\n'); process.exit(0); }
if (args.includes('BatchMode=no')) {
 for(const option of ['StrictHostKeyChecking=ask','PasswordAuthentication=no','KbdInteractiveAuthentication=no','ClearAllForwardings=yes','ForwardAgent=no','ForwardX11=no']) assert.ok(args.includes(option));
 assert.equal(args.at(-1),'true'); assert.equal(process.env.SSH_ASKPASS_REQUIRE,'force');
 assert.equal(process.env.DISPLAY, undefined); assert.equal(process.env.TERM, undefined);
 const prompt="The authenticity of host 'fixture-cloud (192.0.2.1)' can't be established.\\nED25519 key fingerprint is SHA256:"+'a'.repeat(43)+".\\nThis key is not known by any other names.\\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";
 const helper=require('node:child_process').spawnSync(process.env.SSH_ASKPASS,[current.badPrompt || prompt],{env:process.env,encoding:'utf8'});
 if(helper.status===0 && helper.stdout==='yes\\n') require('node:fs').writeFileSync(${JSON.stringify(knownHosts)},'fixture-cloud fixture-key\\n');
 process.exit(255);
}
if (current.sshFailure === 'changed') { clientError('@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\\nHost key verification failed.\\n'); process.exit(255); }
if (current.sshFailure && !require('node:fs').readFileSync(${JSON.stringify(knownHosts)},'utf8')) { clientError('No ED25519 host key is known for fixture-cloud and you have requested strict checking.\\nHost key verification failed.\\n'); process.exit(255); }
if (current.loginRejected) { clientError('user@fixture-cloud: Permission denied (publickey).\\n'); process.exit(255); }
for (const flag of ['BatchMode=yes','ClearAllForwardings=yes','ForwardAgent=no','ForwardX11=no','ConnectTimeout=10']) assert.ok(args.includes(flag));
const split = args.indexOf('--'); const host = args[split+1];
assert.ok(['fixture-cloud','other-cloud','offline-cloud','version-cloud','invalid-cloud','provider-cloud','configuration-cloud','cancelled-cloud'].includes(host));
if (host === 'offline-cloud') { process.stderr.write('RAW SSH SECRET'); process.exit(1); }
if (args.at(-1) === 'uname -s; uname -m' && current.diagnosticOverflow) {
 const diagnostic = args[args.indexOf('-E') + 1];
 assert.ok(diagnostic);
 require('node:fs').appendFileSync(${JSON.stringify(overflowInfo)}, JSON.stringify({diagnostic, pid:process.pid})+'\\n');
 require('node:fs').appendFileSync(diagnostic, Buffer.alloc(16385));
 setInterval(() => {}, 1000);
 return;
}
if (args.at(-1) === 'uname -s; uname -m' && current.remoteHostKeyExit) { process.stderr.write('No ED25519 host key is known for fixture-cloud and you have requested strict checking.\\nHost key verification failed.\\n'); process.exit(current.remoteHostKeyExit); }
if (args.at(-1) === 'uname -s; uname -m') { process.stdout.write(${JSON.stringify(`${platform === "darwin" ? "Darwin" : "Linux"}\n${process.arch === "x64" ? "x86_64" : platform === "darwin" ? "arm64" : "aarch64"}\n`)}); process.exit(0); }
// Standalone fixed libc preflight has no daemon protocol handshake.
if (args.at(-1).includes('FOOM-LIBC-UNSUPPORTED') && !args.at(-1).includes('FOOM-READY')) { if(require('node:fs').readFileSync(${JSON.stringify(scenario)},'utf8').includes('musl')) { process.stdout.write('FOOM-LIBC-UNSUPPORTED'); process.exit(1); } process.exit(0); }
process.stdout.write('FOOM-READY\\n');
let input=Buffer.alloc(0), terminalOutput='', recipeInput='', recipeEnded=false, finishTimer;
const {spawnSync}=require('node:child_process');
const {selectHostRecipe}=require(${JSON.stringify(path.resolve("build/shared/registered-host-recipes.js"))});
function frame(message) { const data=Buffer.from(JSON.stringify({version:3,message})); const head=Buffer.alloc(4); head.writeUInt32BE(data.length); return Buffer.concat([head,data]); }
function send(message) { process.stdout.write(frame(message)); }
process.stdin.on('data', bytes => {
 input=Buffer.concat([input,bytes]);
 while(input.length>=4 && input.length>=4+input.readUInt32BE(0)) {
  const n=input.readUInt32BE(0); const {message}=JSON.parse(input.subarray(4,4+n)); input=input.subarray(4+n);
  if(message.type==='open') {
    assert.equal(message.human,true);
    if(message.trustOrigin) {
      const {originSshArgs}=require(${JSON.stringify(path.resolve("build/shared/registered-hosts.js"))});
      assert.equal(message.trustOrigin,'git@forge.test:team/project.git');
      const args=originSshArgs(message.trustOrigin);
      assert.ok(args.includes('StrictHostKeyChecking=ask'));
      assert.deepEqual(args.slice(-2),['--','git@forge.test']);
      terminalOutput='FIXTURE_VERIFY_FINGERPRINT_AND_ANSWER_SSH\\r\\n';
      send({type:'open-result',id:message.id,request:message.request,state:'live'});continue;
    }
    const recipe=selectHostRecipe(message.recipe,{distro:'debian',libc:'supported',packageManager:'apt'});
    assert.equal(message.recipe.digest,require('node:crypto').createHash('sha256').update(JSON.stringify(recipe.steps)).digest('hex'));
    assert.ok(recipe);
    for (const step of recipe.steps) {
      const child=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(recipeFixture)},...step],{env:{},encoding:'utf8'});
      assert.equal(child.status,0); terminalOutput=child.stdout;
    }
    const immediate=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(scenario)},'utf8'));
    const opened={type:'open-result',id:message.id,request:message.request,state:'live'};
    if(immediate.recipeImmediateExit) {
      recipeEnded=true;
      require('node:fs').writeFileSync(${JSON.stringify(scenario)},JSON.stringify({...immediate,facts:{...immediate.facts,tools:[{id:'git',state:'ready',signIn:'unknown'},{id:'gh',state:'ready',signIn:'signed-out'}]}}));
      process.stdout.write(Buffer.concat([frame(opened),frame({type:'exit',id:message.id,code:0})]));
    } else send(opened);
    continue;
  }
  if('id' in message) {
    if(message.type==='kill') {
      appendFileSync(${JSON.stringify(calls)},JSON.stringify({host,message:{type:message.type,id:message.id},closed:message.id})+'\\n');
      recipeEnded=true;clearInterval(finishTimer);
      send({type:'exit',id:message.id,code:143});
    }
    const recipeSettings=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(scenario)},'utf8'));
    if(message.type==='write' && recipeSettings.recipeInteractive && !recipeEnded) {
      recipeInput+=message.data;
      if(recipeInput.includes('fixture-password'+String.fromCharCode(13))) {
        recipeEnded=true;
        require('node:fs').writeFileSync(${JSON.stringify(scenario)},JSON.stringify({...recipeSettings,facts:{...recipeSettings.facts,tools:[{id:'git',state:'ready',signIn:'unknown'},{id:'gh',state:'ready',signIn:'signed-out'}]}}));
        send({type:'exit',id:message.id,code:recipeSettings.recipeExit ?? 0});
      }
    }
    if(message.type==='attach') {
      if(!finishTimer) finishTimer=setInterval(()=>{ const next=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(scenario)},'utf8')); if(next.recipeExit !== undefined && !next.recipeInteractive && !recipeEnded) { recipeEnded=true;clearInterval(finishTimer);send({type:'exit',id:message.id,code:next.recipeExit}); } },20);
      send({type:'data',id:message.id,view:message.view,token:'fixture-recipe',data:terminalOutput+(recipeSettings.recipeInteractive?'[sudo] password: ':'')});
      if(recipeSettings.recipeExit !== undefined && !recipeSettings.recipeInteractive && !recipeEnded) {recipeEnded=true;send({type:'exit',id:message.id,code:recipeSettings.recipeExit});}
    }
    send({type:'result',id:message.id,request:message.request,lines:terminalOutput.split('\\r\\n'),cols:80,rows:24,title:'Recipe'});
    continue;
  }
  assert.equal('id' in message,false); appendFileSync(${JSON.stringify(calls)},JSON.stringify({host,message})+'\\n');
  if(message.type==='hello') { const settings=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(scenario)},'utf8')); send({type:'hello',agentSettings:1,...(settings.compatibleBuild?{build:'b'.repeat(64),compatible:2,startupTheme:1,hostFacts:1,hostPreflight:1,hostRowCheck:1}:{build:host==='version-cloud'?'b'.repeat(64):${JSON.stringify(manifest.sha256)}})}); continue; }
  if(message.type==='inventory') {send({type:'inventory-result',own:[],foreign:[]}); continue;}
  assert.equal(message.type,'manage');
  const scenario=require('node:fs').readFileSync(${JSON.stringify(scenario)},'utf8'); const settings=JSON.parse(scenario);
  let result;
  if(message.codeFolder==='~/unsafe') result={ok:false,reason:'unsafe-folder'};
  else if(message.codeFolder==='~/refused') result={ok:false,reason:'folder-refused'};
  else if(message.operation==='clone' && host==='fixture-cloud' && !settings.cloneSuccess) {process.stderr.write('RAW GIT SECRET');result={ok:false,reason:require('node:fs').readFileSync(${JSON.stringify(cloneReason)},'utf8')};}
  else {
   const folder=message.codeFolder.startsWith('~/')?'/remote/account/'+message.codeFolder.slice(2):message.codeFolder;
   result={ok:true,facts:{folder:{state:'pass'},codeFolder:folder,version:${JSON.stringify(manifest.version)},sessions:2,cores:8,load:[0.42,0.31,0.25],memoryTotal:17179869184,memoryAvailable:11811160064,requirements:{distro:'debian',libc:'supported',packageManager:'apt'},tools:[{id:'git',state:'missing',signIn:'unknown'},{id:'gh',state:'ready',signIn:'signed-out'}],agents:[{id:'claude',state:'ready'},{id:'codex',state:'missing'},{id:'agy',state:'unable'}]}};
   if(message.operation==='repository' || message.operation==='clone') result.checkout={path:folder+'/'+message.directory,state:message.operation==='clone'?'clean':'absent'};
  }
  if(result.ok) { if(settings.facts) Object.assign(result.facts,settings.facts); if(message.operation==='origin' && settings.origin) result={ok:false,reason:settings.origin}; if(message.operation==='repository' && settings.checkout && result.ok) { result.checkout.state=settings.checkout; } }
  if(message.operation==='inspect' && message.target?.kind==='facts' && settings.factsFailure) result={ok:false,reason:settings.factsFailure};
  if(message.operation==='inspect' && !message.target && settings.inspectFailure) result={ok:false,reason:settings.inspectFailure};
  if(host==='invalid-cloud') result={ok:true,facts:{}};
  const failures={'provider-cloud':'provider-invalid','configuration-cloud':'configuration-changed','cancelled-cloud':'cancelled'};
  if(failures[host]) result={ok:false,reason:failures[host]};
  const held = settings.hold && message.operation===(settings.hold===true?'inspect':settings.hold);
  const heldClone = settings.holdClone && message.operation==='clone';
  if(held || heldClone) { appendFileSync(${JSON.stringify(calls)},JSON.stringify({host,message,phase:'held'})+'\\n'); const timer=setInterval(()=>{ const next=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(scenario)},'utf8')); if((!held || next.hold!==settings.hold) && (!heldClone || !next.holdClone)) {clearInterval(timer);send({type:'managed',result});}},20); } else send({type:'managed',result});
 }
});
`,
    { mode: 0o700 },
  );
  const app = await launchApp(context, { fixture: "repository", env: { PATH: bin } });
  fixtureCleanup(context).apps.push(async () => {
    for (const name of ["foom-host.gz", "manifest.json"]) {
      const backup = backups.get(name);
      if (backup) await writeFile(path.join(catalog, name), backup);
      else await rm(path.join(catalog, name), { force: true });
    }
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(1280, 1200),
  );
  const page = await boardPage(app);
  const repository = await page.evaluate(
    async () => (await window.desktop.workspace()).repositories[0].path,
  );
  gitSync(["remote", "add", "origin", "git@forge.test:team/project.git"], { cwd: repository });
  const capture = async (name) => {
    if (["partial-facts", "repositories-per-host"].includes(name)) await assertAccessible(page);
    await captureHosts(app, page, name);
  };
  const updateScenario = async (value) => {
    await writeFile(`${scenario}.next`, JSON.stringify(value));
    await rename(`${scenario}.next`, scenario);
  };
  const heldCloneCount = async () =>
    (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(({ message, phase }) => message.operation === "clone" && phase === "held").length;
  await page.evaluate(() =>
    window.desktop.saveSetup({
      agents: { claude: true, codex: true, agy: false, copilot: false, opencode: false, pi: false },
    }),
  );
  await openSettingsScreen(page);
  const navigation = page.getByRole("navigation", { name: "Settings sections" });
  await navigation.getByRole("button", { name: "Hosts", exact: true }).click();
  await expect(page.getByText("No hosts", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add host", exact: true }).click();
  if (captureEnrollment) await capture("add-host");
  await page.getByLabel("SSH host", { exact: true }).fill("fixture-cloud");
  await page.getByRole("button", { name: "Add host", exact: true }).click();
  const card = page.getByRole("region", { name: "fixture-cloud", exact: true });
  const progressStatus = card.locator(".host-check-progress[role=status]");
  await expect(card.locator(".host-checks")).toHaveAttribute("aria-busy", "false");
  if (initialScenario.sshFailure) {
    await expect(card.getByText("Host key not trusted", { exact: true }).first()).toBeVisible();
    return {
      app,
      page,
      card,
      navigation,
      capture,
      updateScenario,
      knownHosts,
      calls,
    };
  }
  await expect(card.getByText("Pass · Host key trusted", { exact: true })).toBeVisible();
  await expect(card.getByText("Not found", { exact: true })).toHaveCount(1);
  await expect(card.getByRole("button", { name: "Install codex", exact: true })).toHaveCount(0);
  await expect(card.getByText("Not checked", { exact: true })).toHaveCount(1);
  if (captureEnrollment) await capture("partial-facts");
  return {
    app,
    bin,
    page,
    card,
    navigation,
    progressStatus,
    capture,
    updateScenario,
    overflowInfo,
    heldCloneCount,
    platform,
    catalog,
    compressed,
    calls,
    cloneReason,
    recipeCalls,
  };
}

test("first-use repository launch exposes each fixed clone failure and Settings has no clone control", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { page, card, cloneReason, calls, capture } = await hostsFixture(context);
  await expect(card.getByRole("button", { name: "Clone here", exact: true })).toHaveCount(0);
  await capture("no-clone-control");
  for (const reason of [
    "origin-auth",
    "origin-host-key",
    "origin-unreachable",
    "timed-out",
    "checkout-invalid",
  ]) {
    await writeFile(cloneReason, reason);
    const message = await page.evaluate(async () => {
      const repository = (await window.desktop.workspace()).repositories[0].path;
      try {
        await window.desktop.sidebarCommand({
          kind: "repository-launch",
          repository,
          host: "fixture-cloud",
          run: "shell",
        });
        return "unexpected success";
      } catch (error) {
        return error.message;
      }
    });
    assert.ok(message.includes(`foom-error:${reason}`), message);
    assert.ok(!message.includes("RAW GIT SECRET"));
  }
  const recorded = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(recorded.filter(({ message }) => message.operation === "clone").length, 5);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Actions for shell-fixture", exact: true }).click();
  await page.getByRole("menuitem", { name: "New worktree", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "fixture-cloud", exact: true })).toBeVisible();
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (mode) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${mode}` }),
      mode,
    );
    await expect
      .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
      .toBe(mode === "dark");
    await page.screenshot({ path: evidencePath(`1074/sidebar-first-use-${mode}.png`) });
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await writeFile(cloneReason, "origin-auth");
  await page.getByRole("button", { name: "Actions for shell-fixture", exact: true }).click();
  await page.getByRole("menuitem", { name: "New agent", exact: true }).click();
  await page.getByRole("menuitem", { name: "fixture-cloud", exact: true }).click();
  await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
  const failure = page.getByRole("region", { name: "Tile 1: Claude Code", exact: true });
  await expect(failure).toContainText(
    "Configure Git access on the host: HTTPS through gh, a deploy key, or ssh-agent.",
  );
  await expect(failure).not.toContainText("RAW GIT SECRET");
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (mode) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${mode}` }),
      mode,
    );
    await expect
      .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
      .toBe(mode === "dark");
    await page.screenshot({ path: evidencePath(`1074/origin-auth-hints-${mode}.png`) });
  }
});

test("Hosts edits names during checks and enrolls optional nicknames", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, card, updateScenario, calls } = await hostsFixture(context, true);
  const name = card.getByRole("button", { name: "Rename fixture-cloud", exact: true });
  await expect(name.locator("svg")).toBeVisible();
  await updateScenario({ hold: true });
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect
    .poll(async () => (await readFile(calls, "utf8")).includes('"phase":"held"'))
    .toBe(true);
  await name.click();
  await card.getByLabel("Host nickname", { exact: true }).fill("During check");
  await card.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(card.getByRole("button", { name: "Rename During check" })).toBeVisible();
  await captureHosts(app, page, "renamed-during-check");
  await updateScenario({});
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  await expect(card.getByRole("button", { name: "Rename During check" })).toBeVisible();
  await page.getByRole("button", { name: "Add host", exact: true }).click();
  await page.getByLabel("SSH host", { exact: true }).fill("other-cloud");
  const nickname = page.getByLabel("Nickname (optional)");
  await nickname.fill("DURING CHECK");
  await expect(page.getByRole("alert")).toHaveText("Name already used");
  await expect(page.getByRole("button", { name: "Add host", exact: true })).toBeDisabled();
  await nickname.fill("Build box");
  await captureHosts(app, page, "add-nickname");
  await page.getByRole("button", { name: "Add host", exact: true }).click();
  const other = page.getByRole("region", { name: "other-cloud", exact: true });
  await expect(other.getByRole("button", { name: "Rename Build box", exact: true })).toBeVisible();
  const persisted = await page.evaluate(() => window.desktop.setupState());
  assert.equal(
    persisted.settings.registeredHosts.find((entry) => entry.host === "fixture-cloud").nickname,
    "During check",
  );
  assert.equal(
    persisted.settings.registeredHosts.find((entry) => entry.host === "other-cloud").nickname,
    "Build box",
  );
  await assertAccessible(page);
});

test("Hosts authorizes SSH hosts and validates nicknames without remote calls", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, card, navigation, calls } = await hostsFixture(context, true);
  const nicknameCapture = (name) => captureHosts(app, page, `nickname-${name}`);
  await nicknameCapture("default");
  const beforeRename = (await readFile(calls, "utf8")).split("\n").filter(Boolean).length;
  await card.getByRole("button", { name: "Rename fixture-cloud", exact: true }).click();
  await card.getByLabel("Host nickname", { exact: true }).fill("Build box");
  await nicknameCapture("editing");
  await card.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(card.getByRole("button", { name: "Rename Build box", exact: true })).toBeVisible();
  assert.equal((await readFile(calls, "utf8")).split("\n").filter(Boolean).length, beforeRename);
  await expect(card.getByText("fixture-cloud", { exact: true })).toBeVisible();
  await nicknameCapture("renamed");
  // A nickname may claim a temporarily unused default; restoring that default must refuse.
  await page.getByRole("button", { name: "Add host", exact: true }).click();
  await page.getByLabel("SSH host", { exact: true }).fill("other-cloud");
  await page.getByRole("button", { name: "Add host", exact: true }).click();
  const otherCard = page.getByRole("region", { name: "other-cloud", exact: true });
  await expect(
    otherCard.getByRole("button", { name: "Check capabilities", exact: true }),
  ).toBeEnabled();
  await otherCard.getByRole("button", { name: "Rename other-cloud", exact: true }).click();
  await otherCard.getByLabel("Host nickname", { exact: true }).fill("fixture-cloud");
  await otherCard.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(
    otherCard.getByRole("button", { name: "Rename fixture-cloud", exact: true }),
  ).toBeVisible();
  await card.getByRole("button", { name: "Rename Build box", exact: true }).click();
  await card.getByLabel("Host nickname", { exact: true }).fill("");
  await expect(card.getByRole("alert")).toHaveText("Name already used");
  await expect(card.getByRole("button", { name: "Save name", exact: true })).toBeDisabled();
  await card.getByLabel("Host nickname", { exact: true }).press("Enter");
  assert.equal(
    await page.evaluate(
      async () =>
        (await window.desktop.setupState()).settings.registeredHosts.find(
          (host) => host.host === "fixture-cloud",
        ).nickname,
    ),
    "Build box",
  );
  await nicknameCapture("reset-collision");
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await otherCard.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(otherCard).toHaveCount(0);

  await card.getByRole("button", { name: "Rename Build box", exact: true }).click();
  await card.getByLabel("Host nickname", { exact: true }).fill("<invalid>");
  await expect(card.getByRole("button", { name: "Save name", exact: true })).toBeDisabled();
  await nicknameCapture("invalid");
  await card.getByLabel("Host nickname", { exact: true }).press("Escape");
  await navigation.getByRole("button", { name: "Repositories", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Build box", exact: true })).toBeVisible();
  await nicknameCapture("repositories");
  await navigation.getByRole("button", { name: "Hosts", exact: true }).click();
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  await expect(card.getByRole("button", { name: "Rename Build box", exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Rename Build box", exact: true }).click();
  await card.getByLabel("Host nickname", { exact: true }).fill("");
  await card.getByLabel("Host nickname", { exact: true }).press("Enter");
  await expect(
    card.getByRole("button", { name: "Rename fixture-cloud", exact: true }),
  ).toBeVisible();
  await nicknameCapture("reset");
});

test("Hosts shows independent inspection and repository check progress", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, card, progressStatus, capture, updateScenario } = await hostsFixture(context);
  await assertAccessible(page);
  await updateScenario({ hold: true });
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add host", exact: true })).toBeEnabled();
  await expect(progressStatus).toHaveText("Checking host…");
  await expect(card.locator(".host-throbber")).toBeVisible();
  await capture("progress-inspect");
  await updateScenario({});
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  const checkingOrigin = {
    hold: "origin",
    facts: { tools: [{ id: "git", state: "ready", signIn: "unknown" }] },
  };
  await updateScenario(checkingOrigin);
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(progressStatus).toHaveText("Checking Git access · shell-fixture (1 of 1)");
  await expect(card.locator(".host-throbber")).toBeVisible();
  const originRow = card.locator(".host-check-row").filter({ hasText: "Git access to origin" });
  const checkoutRow = card.locator(".host-check-row").filter({ hasText: "Repository checkout" });
  await expect(originRow).toContainText("Checking…");
  await expect(checkoutRow).toHaveCount(0);
  const workingSymbol = originRow.locator(".host-work .host-symbol");
  const assertSpinnerCentered = async () => {
    await expect(workingSymbol).toHaveCSS("translate", "0px -50%");
    await expect(workingSymbol).toHaveCSS("transform", "none");
    await expect(workingSymbol).toHaveCSS("animation-name", "host-spin");
    // Sample the actual CSS animation at quarter turns, without wall-clock waits.
    const centers = await workingSymbol.evaluate(async (symbol) => {
      const animation = symbol.getAnimations()[0];
      animation.pause();
      const centers = [];
      try {
        for (const time of [0, 250, 500, 750]) {
          animation.currentTime = time;
          await new Promise(requestAnimationFrame);
          const bounds = symbol.getBoundingClientRect();
          const row = symbol.closest(".host-check-row").getBoundingClientRect();
          centers.push({
            x: bounds.x + bounds.width / 2 - row.x,
            y: bounds.y + bounds.height / 2 - row.y - row.height / 2,
            rotate: getComputedStyle(symbol).rotate,
          });
        }
      } finally {
        animation.play();
      }
      return centers;
    });
    assert.equal(new Set(centers.map(({ rotate }) => rotate)).size, 4);
    for (const center of centers) {
      assert.ok(Math.abs(center.x - centers[0].x) < 0.1, JSON.stringify(centers));
      assert.ok(Math.abs(center.y - centers[0].y) < 0.1, JSON.stringify(centers));
      // The row's bottom border can offset its border-box center by half a pixel.
      assert.ok(Math.abs(center.y) < 1, JSON.stringify(centers));
    }
  };
  await assertSpinnerCentered();
  await originRow.screenshot({ path: evidencePath("1041/check-row-spinner.png") });
  await expect(card.locator(".host-throbber")).toHaveCSS("animation-name", "host-check-spin");
  await capture("progress-origin");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(960, 960),
  );
  const progressBounds = await card.locator(".host-summary-row").evaluate((heading) => ({
    width: heading.clientWidth,
    scroll: heading.scrollWidth,
  }));
  assert.ok(progressBounds.scroll <= progressBounds.width + 1);
  await capture("progress-origin-narrow");
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    window.setMinimumSize(600, 640);
    window.setContentSize(640, 960);
  });
  await expect.poll(() => page.evaluate(() => matchMedia("(max-width: 650px)").matches)).toBe(true);
  await assertSpinnerCentered();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(1280, 1200),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(card.locator(".host-throbber")).toHaveCSS("animation-name", "none");
  await expect(workingSymbol).toHaveCSS("animation-name", "none");
  await capture("progress-origin-reduced");
  // Release origin, then hold checkout: the step text still advances without animation.
  await updateScenario({ ...checkingOrigin, hold: "repository" });
  await expect(progressStatus).toHaveText("Checking checkout · shell-fixture (1 of 1)");
  await expect(originRow).toContainText("Pass · Reachable");
  await expect(checkoutRow).toHaveCount(0);
  await capture("progress-checkout-reduced");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await capture("progress-checkout");
  await updateScenario({ ...checkingOrigin, hold: false });
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  await expect(card.locator(".host-throbber")).toHaveCount(0);
  await expect(checkoutRow).toHaveCount(0);
  await capture("progress-result");
});

test("Hosts renders Git failures and platform capability diagnostics", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { card, platform, capture, updateScenario } = await hostsFixture(context);
  await updateScenario({
    facts: {
      tools: [
        { id: "git", state: "ready", signIn: "unknown" },
        { id: "gh", state: "ready", signIn: "signed-out" },
      ],
    },
    origin: "origin-auth",
  });
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(
    card.getByText("Origin authentication failed · origin-auth", { exact: true }),
  ).toBeVisible();
  await expect(card.getByLabel("Git access fixes")).toBeVisible();
  await capture("failed-origin-fix-actions");
  await card.getByRole("button", { name: "Change folder", exact: true }).click();
  await card.getByLabel("Code folder", { exact: true }).fill("~/new-code");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  await expect(card.getByText("/remote/account/new-code", { exact: true })).toBeVisible();
  // Each fixed no-prompt Git failure is rendered in the host checklist.
  for (const reason of [
    "origin-auth",
    "origin-host-key",
    "origin-unreachable",
    "timed-out",
    "checkout-invalid",
  ]) {
    await updateScenario({
      facts: { tools: [{ id: "git", state: "ready", signIn: "unknown" }] },
      origin: reason,
    });
    await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
    await expect(
      card.locator(".host-check-row").filter({ hasText: "Git access to origin" }),
    ).toContainText(reason);
  }
  // Available facts do not claim a Keychain or Remote Login diagnosis.
  await updateScenario({
    facts: {
      requirements: {
        distro: "darwin",
        libc: "supported",
        packageManager: "brew",
        mac: { commandLineTools: false, protectedFolder: true, staysAwake: false },
      },
      tools: [
        { id: "git", state: "missing", signIn: "unknown" },
        { id: "gh", state: "ready", signIn: "unknown" },
      ],
    },
  });
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(card.getByText("Warning · Protected folder", { exact: true })).toBeVisible();
  await expect(card.getByText("Do this on the Mac", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Install git", exact: true })).toHaveCount(0);
  await capture("fresh-mac");
  await updateScenario({
    facts: {
      requirements: {
        distro: "darwin",
        libc: "supported",
        packageManager: "brew",
        mac: { commandLineTools: true, protectedFolder: false, staysAwake: true },
      },
    },
  });
  await card.getByRole("button", { name: "Reload Code folder", exact: true }).click();
  await expect(card.getByText("Pass · Valid", { exact: true })).toBeVisible();
  await expect(card.getByText("Do this on the Mac", { exact: true })).toBeVisible();
  await expect(card.getByText("Warning · Sleeps when idle", { exact: true })).toBeVisible();
  await updateScenario({
    facts: { requirements: { distro: "unknown", libc: "supported", packageManager: "none" } },
  });
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  await expect(card.getByRole("button", { name: /^Install/u })).toHaveCount(0);
  await capture("no-recipe");
  if (platform === "linux") {
    await updateScenario({ musl: true });
    await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
    await expect(
      card.getByText("Unsupported · musl libc · libc-unsupported", { exact: true }),
    ).toBeVisible();
    await capture("unsupported-platform");
  }
});

test("Hosts shows readiness and read-only checkouts with explicit origin trust", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, card, capture, updateScenario, calls } = await hostsFixture(context);
  await card.getByRole("button", { name: "Change folder", exact: true }).click();
  await card.getByLabel("Code folder", { exact: true }).fill("~/new-code");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  const ready = {
    facts: {
      tools: [
        { id: "git", state: "ready", signIn: "unknown" },
        { id: "gh", state: "ready", signIn: "signed-in" },
      ],
      agents: [
        { id: "claude", state: "ready", signIn: "signed-in" },
        { id: "codex", state: "ready", signIn: "signed-in" },
        { id: "agy", state: "ready", signIn: "signed-in" },
        { id: "copilot", state: "ready", signIn: "signed-in" },
        { id: "opencode", state: "ready", signIn: "signed-in" },
        { id: "pi", state: "ready", signIn: "signed-in" },
      ],
      folder: { state: "pass" },
    },
    checkout: "clean",
  };
  await updateScenario(ready);
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(card.getByText("Ready", { exact: true })).toBeVisible();
  await capture("ready");
  await page.evaluate(() =>
    window.desktop.saveSetup({
      agents: { claude: true, codex: true, agy: false, copilot: false, opencode: true, pi: true },
    }),
  );
  const optional = {
    ...ready,
    checkout: "absent",
    facts: {
      ...ready.facts,
      agents: [
        { id: "claude", state: "ready", signIn: "unknown" },
        { id: "codex", state: "ready", signIn: "unknown" },
        { id: "opencode", state: "missing" },
        { id: "pi", state: "missing" },
      ],
    },
  };
  await updateScenario(optional);
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(card.getByText("Ready", { exact: true })).toBeVisible();
  await expect(card.getByText("Not checked out", { exact: true })).toHaveCount(0);
  assert.ok(
    (
      await card
        .getByText("Not found", { exact: true })
        .evaluateAll((els) =>
          els.map((el) => el.closest(".host-status").classList.contains("host-neutral")),
        )
    ).every(Boolean),
  );
  await capture("ready-optional-agents");
  await expect(card.getByRole("button", { name: "Clone here", exact: true })).toHaveCount(0);
  await updateScenario({ ...optional, checkout: "clean" });
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(card.locator(".host-repository-row")).toContainText("shell-fixture");
  await capture("hosts-read-only-checkouts");
  await updateScenario({ ...optional, origin: "origin-host-key" });
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(card.getByRole("button", { name: "Trust host key…", exact: true })).toBeEnabled();
  await capture("origin-host-key");
  const beforeTrust = (await readFile(calls, "utf8")).trim().split("\n").length;
  await card.getByRole("button", { name: "Trust host key…", exact: true }).click();
  await expect(page.locator(".terminal-tile[data-kind='shell']").last()).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const id = (await window.desktop.workspace()).terminals.at(-1)?.id;
        return id ? (await window.desktop.tail(id, 40)).join("\n") : "";
      }),
    )
    .toContain("FIXTURE_VERIFY_FINGERPRINT_AND_ANSWER_SSH");
  await capture("trust-host-key-tile");
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Hosts", exact: true })
    .click();
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  const trustChecks = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .slice(beforeTrust)
    .map((line) => JSON.parse(line))
    .filter(({ message }) => message.type === "manage")
    .map(({ message }) => message.operation)
    .filter((operation) => operation !== "list-worktrees");
  assert.deepEqual(trustChecks, ["origin", "repository"]);
  await updateScenario(ready);
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(card.getByText("Ready", { exact: true })).toBeVisible();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(960, 960),
  );
  const dimensions = await card
    .locator(".host-check-row")
    .evaluateAll((rows) =>
      rows.map((row) => ({ width: row.clientWidth, scroll: row.scrollWidth })),
    );
  assert.ok(dimensions.every((row) => row.scroll <= row.width + 1));
  await assertAccessible(page);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(1280, 1200),
  );
  const recorded = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    recorded.some(
      ({ message }) =>
        message.operation === "origin" && message.origin === "git@forge.test:team/project.git",
    ),
  );
});

test("Hosts creates missing folders and reports enrollment and artifact failures", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { page, card, catalog, compressed, capture, updateScenario } = await hostsFixture(context);
  await card.getByRole("button", { name: "Change folder", exact: true }).click();
  await card.getByLabel("Code folder", { exact: true }).fill("~/new-code");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  await updateScenario({ facts: { folder: { state: "fail", reason: "folder-missing" } } });
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(card.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
  await capture("missing-folder");
  await updateScenario({});
  await card.getByRole("button", { name: "Create", exact: true }).click();
  await expect(card.getByText("Pass · Valid", { exact: true })).toBeVisible();
  for (const [host, text, enrolled] of [
    ["offline-cloud", "Host unreachable", true],
    ["version-cloud", "Host version mismatch", true],
    ["invalid-cloud", "Invalid host reply", false],
    ["provider-cloud", "Agent configuration unavailable", false],
    ["configuration-cloud", "Agent configuration changed", false],
    ["cancelled-cloud", "Host check cancelled", false],
  ]) {
    await page.getByRole("button", { name: "Add host", exact: true }).click();
    await page.getByLabel("SSH host", { exact: true }).fill(host);
    await page.getByRole("button", { name: "Add host", exact: true }).click();
    await expect(
      page.getByText(host === "offline-cloud" ? `${text} · unreachable` : text, { exact: true }),
    ).toBeVisible();
    if (enrolled) {
      const added = page.getByRole("region", { name: host, exact: true });
      await expect(added.getByRole("button", { name: "Remove", exact: true })).toBeEnabled();
      await added.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(added).toHaveCount(0);
    } else await page.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  const artifactPath = path.join(catalog, "foom-host.gz");
  await rm(artifactPath);
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(
    card
      .locator(".host-check-row")
      .filter({ hasText: "Remote daemon" })
      .getByText("This build has no remote host support · artifact-unavailable", { exact: true }),
  ).toBeVisible();
  await expect(card.getByText("Pass · Host key trusted", { exact: true })).toBeVisible();
  await capture("missing-build-support");
  await writeFile(artifactPath, compressed);
  await updateScenario({});
});

test("Repositories lists existing checkouts and opens fixed repair recipes without exposing remote output", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { page, card, navigation, calls, recipeCalls, capture, updateScenario } =
    await hostsFixture(context);
  await card.getByRole("button", { name: "Change folder", exact: true }).click();
  await card.getByLabel("Code folder", { exact: true }).fill("~/new-code");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  await navigation.getByRole("button", { name: "Repositories", exact: true }).click();
  await expect(page.getByRole("region", { name: "Local", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clone here", exact: true })).toHaveCount(0);
  await expect(page.getByText("Not checked out", { exact: true })).toHaveCount(0);
  await updateScenario({ checkout: "clean" });
  await page.getByRole("button", { name: "Refresh locations", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "fixture-cloud", exact: true })
      .getByRole("button", { name: "Copy checkout path", exact: true }),
  ).toBeVisible();
  await capture("repositories-per-host");
  await assertAccessible(page);
  await navigation.getByRole("button", { name: "Hosts", exact: true }).click();
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(card.getByRole("button", { name: "Install git", exact: true })).toBeEnabled();
  const beforeInstall = (await readFile(calls, "utf8")).trim().split("\n").length;
  const lastChecked = await page.evaluate(
    async () =>
      (await window.desktop.setupState()).settings.registeredHosts[0].observation.checkedAt,
  );
  await card.getByRole("button", { name: "Install git", exact: true }).click();
  await expect
    .poll(
      async () => (await readFile(recipeCalls, "utf8")).trim().split("\n").filter(Boolean).length,
    )
    .toBe(2);
  await expect(card.getByRole("region", { name: "Install terminal" })).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const id = (await window.desktop.workspace()).terminals.at(-1)?.id;
        return id ? (await window.desktop.tail(id, 40)).join("\n") : "";
      }),
    )
    .toContain("FIXTURE_RECIPE_COMPLETE");
  await capture("fix-install-tile");
  await updateScenario({
    recipeExit: 0,
    facts: {
      tools: [
        { id: "git", state: "ready", signIn: "unknown" },
        { id: "gh", state: "ready", signIn: "signed-out" },
      ],
    },
  });
  await expect(
    card.getByRole("region", { name: "Install terminal" }).getByRole("status"),
  ).toHaveText("Done");
  await page.getByRole("button", { name: "Close settings (Esc)", exact: true }).click();
  await expect(page.getByRole("region", { name: "Settings", exact: true })).toHaveCount(0);
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Hosts", exact: true })
    .click();
  await expect(card).toBeVisible();
  const expandInstalled = card.getByRole("button", { name: "Expand fixture-cloud", exact: true });
  if (await expandInstalled.count()) await expandInstalled.click();
  await expect(
    card
      .locator(".host-check-row")
      .filter({ has: page.getByRole("button", { name: "Reload git", exact: true }) }),
  ).toContainText("Pass · Installed");
  const installChecks = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .slice(beforeInstall)
    .map((line) => JSON.parse(line))
    .filter(({ message }) => message.type === "manage")
    .map(({ message }) => message);
  assert.deepEqual(
    installChecks
      .filter(({ operation }) => operation === "inspect")
      .map(({ target }) => target ?? null),
    [null, { kind: "tool", tool: "git" }],
  );
  assert.equal(
    installChecks.some(({ operation }) => ["origin", "repository"].includes(operation)),
    false,
  );
  assert.equal(
    await page.evaluate(
      async () =>
        (await window.desktop.setupState()).settings.registeredHosts[0].observation.checkedAt,
    ),
    lastChecked,
  );
  await expect(card.getByRole("button", { name: "Sign in gh", exact: true })).toBeEnabled();
  await card.getByRole("button", { name: "Sign in gh", exact: true }).click();
  await expect
    .poll(
      async () => (await readFile(recipeCalls, "utf8")).trim().split("\n").filter(Boolean).length,
    )
    .toBe(3);
  assert.deepEqual(
    (await readFile(recipeCalls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [
      ["/usr/bin/sudo", "/usr/bin/apt-get", "update"],
      ["/usr/bin/sudo", "/usr/bin/apt-get", "install", "-y", "git"],
      ["gh", "auth", "login", "--web", "--git-protocol", "https", "--skip-ssh-key"],
    ],
  );
  await expect(page.getByRole("region", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(page.locator(".terminal-tile[data-kind='shell']")).toBeVisible();
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Hosts", exact: true })
    .click();
  await expect(card).toBeVisible();
  const expandSignedIn = card.getByRole("button", { name: "Expand fixture-cloud", exact: true });
  if (await expandSignedIn.count()) await expandSignedIn.click();
  await expect(card.getByRole("button", { name: "Remove", exact: true })).toBeEnabled();
  await card.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText("No hosts", { exact: true })).toBeVisible();
  await assert.rejects(page.evaluate(() => window.desktop.saveSetup({ registeredHosts: [] })));
  await expect(page.getByText("RAW GIT SECRET", { exact: true })).toHaveCount(0);
  const recorded = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(recorded.every(({ message }) => message.operation !== "clone"));
});

test("Hosts opens saved checks without SSH and keeps ready repositories compact", {
  skip: process.platform === "win32",
  timeout: deadline(30000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "hosts-saved-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const calls = path.join(root, "ssh-calls");
  await writeFile(calls, "");
  await writeFile(
    path.join(bin, "ssh"),
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, 'ssh\\n'); process.exit(1);\n`,
    { mode: 0o700 },
  );
  const facts = {
    codeFolder: "/remote/code",
    version: "0.1.0",
    sessions: 3,
    cores: 8,
    load: [0, 0, 0],
    memoryTotal: 8 * 1024 ** 3,
    memoryAvailable: 4 * 1024 ** 3,
    folder: { state: "pass" },
    requirements: { distro: "debian", libc: "supported", packageManager: "apt" },
    tools: [{ id: "git", state: "ready", signIn: "unknown" }],
    agents: [{ id: "claude", state: "ready", signIn: "signed-in" }],
  };
  const result = { ok: true, facts };
  const preflight = {
    ssh: { state: "pass" },
    platform: { state: "pass" },
    artifact: { state: "pass" },
    result,
    repositories: Array.from({ length: 6 }, (_, index) => ({
      repository: `/local/project-${index}`,
      origin: { state: "pass" },
      checkout: { ...result, checkout: { path: `/remote/project-${index}`, state: "clean" } },
    })),
  };
  await writeFile(
    path.join(root, "settings.json"),
    JSON.stringify({
      version: 1,
      settings: {
        setupComplete: true,
        checkForUpdates: false,
        restoreSessions: false,
        registeredHosts: [
          {
            host: "saved-fixture",
            codeFolder: facts.codeFolder,
            observation: {
              checkedAt: 1700000000000,
              preflight,
              foreignSessions: 2,
              foreignWorktrees: 4,
            },
          },
        ],
      },
    }),
  );
  const app = await launchApp(context, {
    fixture: "empty-board",
    args: [`--user-data-dir=${root}`],
    env: { PATH: bin },
  });
  const page = await boardPage(app);
  await openSettingsScreen(page);
  const navigation = page.getByRole("navigation", { name: "Settings sections" });
  const before = await readFile(calls, "utf8");
  await navigation.getByRole("button", { name: "Hosts", exact: true }).click();
  const card = page.getByRole("region", { name: "saved-fixture", exact: true });
  await expect(card.getByText("Ready", { exact: true })).toBeVisible();
  const capture = (name) => captureHosts(app, page, `saved-${name}`);
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeHidden();
  const fits = await page
    .locator(".hosts-page")
    .evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight);
  assert.equal(fits, true);
  await capture("collapsed");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(1280, 800),
  );

  await card.getByRole("button", { name: "Expand saved-fixture", exact: true }).click();
  await expect(card.getByText("Last checked", { exact: false })).toBeVisible();
  await expect(card.getByText("Repository · project-0", { exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  await assertHostColumns(card);
  await capture("expanded");
  await card.getByRole("button", { name: /Git access · 6 ready/ }).click();
  await expect(card.locator(".host-repository-row")).toHaveCount(6);
  await assertHostColumns(card);
  await capture("repositories");
  for (const width of [900, 640]) {
    await app.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      window.setMinimumSize(600, 640);
      window.setContentSize(width, 1000);
    }, width);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    await assertHostColumns(card);
    await capture(`repositories-${width}`);
    await card.getByRole("button", { name: /Git access · 6 ready/ }).click();
    await assertHostColumns(card);
    await capture(`expanded-${width}`);
    await card.getByRole("button", { name: /Git access · 6 ready/ }).click();
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(1280, 800),
  );
  await card.getByRole("button", { name: /Git access · 6 ready/ }).click();
  await card.getByText("Host facts", { exact: true }).click();
  await expect(card.getByText("Other profiles or untagged: 2", { exact: true })).toBeVisible();
  await capture("inventory");
  await assertAccessible(page);
  assert.equal(await readFile(calls, "utf8"), before);
  await navigation.getByRole("button", { name: "General", exact: true }).click();
  await navigation.getByRole("button", { name: "Hosts", exact: true }).click();
  await expect(card.getByText("Ready", { exact: true })).toBeVisible();
  assert.equal(await readFile(calls, "utf8"), before);
});

test("Hosts reloads individual rows and actions never trigger full capability checks", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, card, calls, updateScenario } = await hostsFixture(context);
  const capabilityCalls = async () =>
    (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(
        ({ message, phase }) =>
          // Sidebar checkout discovery is a separate read-only refresh after
          // registration changes. Keep every capability/row action in this count.
          message.type === "manage" &&
          !["list-worktrees", "repository"].includes(message.operation) &&
          !phase,
      )
      .map(({ message }) => message);
  const checkedAt = () =>
    page.evaluate(
      async () =>
        (await window.desktop.setupState()).settings.registeredHosts[0].observation.checkedAt,
    );
  // Enrollment notifies the sidebar asynchronously. Finish that independent
  // checkout read before measuring the requests caused by a row action.
  await page.evaluate(() => window.desktop.sidebarInventory());
  const timestamp = await checkedAt();
  let before = (await capabilityCalls()).length;
  await updateScenario({
    hold: "inspect",
    facts: {
      tools: [
        { id: "git", state: "ready", signIn: "unknown" },
        { id: "gh", state: "missing", signIn: "unknown" },
      ],
    },
  });
  const gitRow = card
    .locator(".host-check-row")
    .filter({ has: page.getByRole("button", { name: "Reload git", exact: true }) });
  await gitRow.hover();
  const reload = card.getByRole("button", { name: "Reload git", exact: true });
  await expect(reload).toHaveCSS("opacity", "1");
  await reload.click();
  await expect(gitRow).toContainText("Checking…");
  await expect(card.getByRole("button", { name: "Reload SSH", exact: true })).toBeEnabled();
  await expect(card.getByRole("button", { name: "Change folder", exact: true })).toBeEnabled();
  await captureHosts(app, page, "1061/row-reload-pending");
  await updateScenario({});
  await expect(gitRow).toContainText("Pass · Installed");
  const afterReload = (await capabilityCalls()).slice(before);
  assert.equal(afterReload.length, 1, JSON.stringify(afterReload));
  assert.deepEqual(afterReload[0].target, { kind: "tool", tool: "git" });
  // The fixture returned changed gh facts too. Its row must retain its prior result.
  await expect(card.getByRole("button", { name: "Sign in gh", exact: true })).toBeVisible();
  assert.equal(await checkedAt(), timestamp);
  await captureHosts(app, page, "1061/row-reload-complete");
  before = (await capabilityCalls()).length;
  await card.getByRole("button", { name: "Change folder", exact: true }).click();
  await card.getByLabel("Code folder", { exact: true }).fill("~/new-code");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  assert.deepEqual(
    (await capabilityCalls()).slice(before).map(({ operation, target }) => ({ operation, target })),
    [{ operation: "inspect", target: { kind: "folder" } }],
  );
  await expect(card.getByText("Repository checkout", { exact: true })).toHaveCount(0);
  assert.equal(await checkedAt(), timestamp);
  // A row reload can reconcile a missing folder, then Create uses only its own reply.
  await updateScenario({ facts: { folder: { state: "fail", reason: "folder-missing" } } });
  await card.getByRole("button", { name: "Reload Code folder", exact: true }).click();
  await expect(card.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
  await updateScenario({});
  before = (await capabilityCalls()).length;
  await card.getByRole("button", { name: "Create", exact: true }).click();
  await expect(card.getByText("Pass · Valid", { exact: true })).toBeVisible();
  assert.deepEqual(
    (await capabilityCalls()).slice(before).map(({ operation }) => operation),
    ["create-folder"],
  );
  assert.equal(await checkedAt(), timestamp);
  await expect(card.getByRole("button", { name: "Clone here", exact: true })).toHaveCount(0);
  // Finish the folder action's location reconciliation before measuring Refresh facts.
  await page.evaluate(() => window.desktop.sidebarInventory());
  await card.getByText("Host facts", { exact: true }).click();
  await updateScenario({ facts: { cores: 4 } });
  before = (await capabilityCalls()).length;
  await card.getByRole("button", { name: "Refresh facts", exact: true }).click();
  await expect(card.getByText("CPU cores", { exact: true }).locator("..")).toContainText("4");
  await expect(card.getByRole("button", { name: "Refresh facts", exact: true })).toBeEnabled();
  assert.deepEqual(
    (await capabilityCalls()).slice(before).map(({ operation, target }) => ({ operation, target })),
    [{ operation: "inspect", target: { kind: "facts" } }],
  );
  assert.equal(await checkedAt(), timestamp);
  await updateScenario({ factsFailure: "unreachable" });
  before = (await capabilityCalls()).length;
  await card.getByRole("button", { name: "Refresh facts", exact: true }).click();
  await expect(card.getByText("Host unreachable", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Refresh facts", exact: true })).toBeEnabled();
  assert.deepEqual(
    (await capabilityCalls()).slice(before).map(({ operation, target }) => ({ operation, target })),
    [{ operation: "inspect", target: { kind: "facts" } }],
  );
  assert.equal(await checkedAt(), timestamp);
  await expect(card.getByText("Pass · Host key trusted", { exact: true })).toBeVisible();
  await captureHosts(app, page, "1061/resource-refresh-failed");
  await assertAccessible(page);
});

test("Hosts preserves a rejected replacement folder and reports unrepresentable row reloads inline", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, card, updateScenario } = await hostsFixture(context);
  const registration = () =>
    page.evaluate(async () => (await window.desktop.setupState()).settings.registeredHosts[0]);
  const original = await registration();
  await card.getByRole("button", { name: "Change folder", exact: true }).click();
  await card.getByLabel("Code folder", { exact: true }).fill("~/refused");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Code folder unavailable", { exact: true })).toBeVisible();
  assert.deepEqual(await registration(), original);
  const folderRow = card.locator(".host-check-row").filter({
    has: page.getByRole("button", { name: "Reload Code folder", exact: true }),
  });
  await expect(folderRow).toContainText("Pass · Valid");
  await captureHosts(app, page, "1061/rejected-folder-change");
  await updateScenario({ inspectFailure: "unreachable" });
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  await expect(card.getByText("Host unreachable", { exact: true }).first()).toBeVisible();
  const failed = await registration();
  assert.equal(failed.observation.preflight.result.ok, false);
  await updateScenario({});
  await card.getByRole("button", { name: "Reload Code folder", exact: true }).click();
  await expect(folderRow).toContainText("Check capabilities required");
  await expect(page.getByText("Unable to reload host row", { exact: true })).toHaveCount(0);
  assert.deepEqual(await registration(), failed);
  await expect(card.getByRole("button", { name: "Reload SSH", exact: true })).toBeEnabled();
  await captureHosts(app, page, "1061/unrepresentable-row-reload");
  await assertAccessible(page);
});

test("Hosts replaces a transient folder reload with the newest folder reply", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, navigation, updateScenario } = await hostsFixture(context);
  await page.evaluate(async () => {
    await window.desktop.hosts({ action: "remove", host: "fixture-cloud" });
    await window.desktop.hosts({ action: "add", host: "fixture-cloud", codeFolder: "~/foom" });
  });
  await navigation.getByRole("button", { name: "General", exact: true }).click();
  await navigation.getByRole("button", { name: "Hosts", exact: true }).click();
  const card = page.getByRole("region", { name: "fixture-cloud", exact: true });
  await card.getByRole("button", { name: "Expand fixture-cloud", exact: true }).click();
  await card.getByRole("button", { name: "Reload Code folder", exact: true }).click();
  await expect(card.getByText("Pass · Valid", { exact: true })).toBeVisible();
  await updateScenario({ facts: { folder: { state: "fail", reason: "folder-missing" } } });
  await card.getByRole("button", { name: "Change folder", exact: true }).click();
  await card.getByLabel("Code folder", { exact: true }).fill("~/new");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("button", { name: "Create", exact: true })).toBeVisible();
  await expect(
    card.getByText("Code folder does not exist · folder-missing", { exact: true }),
  ).toBeVisible();
  await expect(card.getByText("Pass · Valid", { exact: true })).toHaveCount(0);
  const registration = await page.evaluate(
    async () => (await window.desktop.setupState()).settings.registeredHosts[0],
  );
  assert.equal(registration.observation, undefined);
  await captureHosts(app, page, "1061/transient-folder-latest-reply");
  await assertAccessible(page);
});

test("Hosts loads saved rows and retries only persistence after queued profile writes fail", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, card, calls, updateScenario } = await hostsFixture(context);
  const profile = await app.evaluate(({ app }) => app.getPath("userData"));
  const before = await page.evaluate(
    async () =>
      (await window.desktop.setupState()).settings.registeredHosts[0].observation.checkedAt,
  );
  await card.getByRole("button", { name: "Install git", exact: true }).click();
  await expect(card.getByRole("region", { name: "Install terminal" })).toBeVisible();
  const inspectCount = async () =>
    (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(
        ({ message, phase }) =>
          !phase &&
          message.operation === "inspect" &&
          message.target?.kind === "tool" &&
          message.target.tool === "git",
      ).length;
  const initial = await inspectCount();
  try {
    await chmod(profile, 0o555);
    await updateScenario({ recipeExit: 0 });
    await expect(card.getByText("Unable to save", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close settings (Esc)", exact: true }).click();
    await expect(page.getByRole("region", { name: "Settings", exact: true })).toHaveCount(0);
    for (let attempt = 0; attempt < 3; attempt++) {
      await openSettingsScreen(page);
      await page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "Hosts", exact: true })
        .click();
      if (await card.getByRole("button", { name: "Expand fixture-cloud", exact: true }).count())
        await card.getByRole("button", { name: "Expand fixture-cloud", exact: true }).click();
      await expect(card.getByText("Unable to save", { exact: true })).toBeVisible();
      await expect(page.getByText("Unable to load hosts", { exact: true })).toHaveCount(0);
      if (attempt === 0) await captureHosts(app, page, "1061/queued-save-failure");
      await page.getByRole("button", { name: "Close settings (Esc)", exact: true }).click();
      await expect(page.getByRole("region", { name: "Settings", exact: true })).toHaveCount(0);
    }
    assert.equal(await inspectCount(), initial + 1);
  } finally {
    await chmod(profile, 0o700);
  }
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Hosts", exact: true })
    .click();
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  await expect(card.getByText("Unable to save", { exact: true })).toHaveCount(0);
  assert.equal(await inspectCount(), initial + 1);
  assert.equal(
    await page.evaluate(
      async () =>
        (await window.desktop.setupState()).settings.registeredHosts[0].observation.checkedAt,
    ),
    before,
  );
  await assertAccessible(page);
});

test("Hosts merges recipe rows with two Hosts windows already open", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, card, calls, updateScenario } = await hostsFixture(context);
  await page.evaluate(() => window.desktop.appMenu.execute("new-window"));
  await expect
    .poll(() => app.windows().filter((window) => window.url() === "app://bundle/index.html").length)
    .toBe(2);
  const other = app
    .windows()
    .find((window) => window !== page && window.url() === "app://bundle/index.html");
  await expect(other.locator(".config-gear")).toBeVisible();
  await other.locator(".config-gear").click();
  await other.getByRole("menuitem", { name: /^Settings/u }).click();
  await expect(other.getByRole("region", { name: "Settings" })).toBeVisible();
  await other
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Hosts", exact: true })
    .click();
  const otherCard = other.getByRole("region", { name: "fixture-cloud", exact: true });
  await expect(otherCard.getByRole("button", { name: "Install git", exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Sign in gh", exact: true }).click();
  await expect
    .poll(() => page.evaluate(async () => (await window.desktop.workspace()).terminals.length))
    .toBe(1);
  await expect
    .poll(
      async () =>
        (await page.locator(".terminal-tile[data-kind='shell']").last().isVisible()) ||
        (await other.locator(".terminal-tile[data-kind='shell']").last().isVisible()),
    )
    .toBe(true);
  // Recipe reveal closes the receiving board's Settings. The other already-open
  // Hosts view can queue a second recipe without mounting/listing again.
  const remainingCard = (await card.isVisible()) ? card : otherCard;
  await expect(
    remainingCard.getByRole("button", { name: "Install git", exact: true }),
  ).toBeEnabled();
  await remainingCard.getByRole("button", { name: "Install git", exact: true }).click();
  await expect
    .poll(() => page.evaluate(async () => (await window.desktop.workspace()).terminals.length))
    .toBe(2);
  const beforeList = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter(({ message, phase }) => !phase && message.operation === "inspect" && message.target);
  assert.equal(beforeList.length, 0, "neither recipe remounted Hosts or refreshed queued rows");
  await expect(
    remainingCard.getByRole("region", { name: "Install terminal" }).locator(".xterm-screen"),
  ).toContainText("FIXTURE_RECIPE_COMPLETE");
  await updateScenario({ recipeExit: 0 });
  await expect
    .poll(
      async () =>
        (await readFile(calls, "utf8")).split("\n").filter((line) => line.includes('"target"'))
          .length,
    )
    .toBe(2);
  const targets = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter(({ message, phase }) => !phase && message.operation === "inspect" && message.target)
    .map(({ message }) => message.target);
  assert.deepEqual(
    targets.sort((a, b) => a.kind.localeCompare(b.kind)),
    [
      { kind: "sign-in", tool: "gh" },
      { kind: "tool", tool: "git" },
    ],
  );
});

test("Hosts embeds interactive installs, retains outcomes, and refreshes only the installed tool", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, card, calls, updateScenario } = await hostsFixture(context);
  await updateScenario({ recipeInteractive: true });
  const initial = (await readFile(calls, "utf8")).trim().split("\n").length;
  await card.getByRole("button", { name: "Install git", exact: true }).click();
  const terminal = card.getByRole("region", { name: "Install terminal" });
  await expect(terminal).toBeVisible();
  await expect(page.getByRole("region", { name: "Settings", exact: true })).toBeVisible();
  await expect(terminal.locator(".xterm-screen")).toContainText("[sudo] password:");
  await assertAccessible(page);
  await captureHosts(app, page, "1062/install-prompt");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(900, 760),
  );
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(900);
  await captureHosts(app, page, "1062/install-narrow");
  await terminal.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("fixture-password");
  await page.keyboard.press("Enter");
  await expect(terminal.getByRole("status")).toHaveText("Done");
  const gitRow = card
    .locator(".host-check-row")
    .filter({ has: page.getByRole("button", { name: "Reload git", exact: true }) });
  await expect(gitRow).toContainText("Pass · Installed");
  await expect(page.getByRole("region", { name: "Settings", exact: true })).toBeVisible();
  await captureHosts(app, page, "1062/install-done");
  const checks = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .slice(initial)
    .map((line) => JSON.parse(line))
    .filter(({ message, phase }) => !phase && message.operation === "inspect")
    .map(({ message }) => message.target ?? null);
  assert.deepEqual(checks, [null, { kind: "tool", tool: "git" }]);
  await terminal.getByRole("button", { name: "Dismiss" }).click();
  await expect(terminal).toHaveCount(0);
  await updateScenario({
    recipeExit: 23,
    facts: { tools: [{ id: "git", state: "missing", signIn: "unknown" }] },
  });
  await card.getByRole("button", { name: "Reload git", exact: true }).click();
  await expect(card.getByRole("button", { name: "Install git", exact: true })).toBeEnabled();
  await card.getByRole("button", { name: "Install git", exact: true }).click();
  await expect(terminal.getByRole("status")).toHaveText("Failed · exit code 23");
  await expect(gitRow).toContainText("Not found");
  await captureHosts(app, page, "1062/install-failed");
});

test("Hosts retains failed Add stderr in a read-only panel", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, updateScenario } = await hostsFixture(context);
  await page.getByRole("button", { name: "Add host", exact: true }).click();
  const add = page.locator(".host-add");
  await add.getByLabel("SSH host", { exact: true }).fill("offline-cloud");
  await add.getByRole("button", { name: "Add host", exact: true }).click();
  const output = page
    .getByRole("region", { name: "offline-cloud", exact: true })
    .getByRole("region", { name: "Host check output" });
  await expect(output).toContainText("RAW SSH SECRET");
  await expect(output.getByRole("status")).toHaveText("Failed");
  await expect(output.locator("pre")).toHaveText(/RAW SSH SECRET\nFailed · unreachable\n$/u);
  await captureHosts(app, page, "1062/add-failed");
  await output.getByRole("button", { name: "Dismiss" }).click();
  await expect(output).toHaveCount(0);
  await updateScenario({ hold: "inspect" });
  await page.getByRole("button", { name: "Add host", exact: true }).click();
  await add.getByLabel("SSH host", { exact: true }).fill("other-cloud");
  await add.getByRole("button", { name: "Add host", exact: true }).click();
  const live = add.getByRole("region", { name: "Host check output" });
  await expect(live).toContainText("Daemon ready · Inspecting…");
  await expect(live.getByRole("status")).toHaveText("Checking…");
  await captureHosts(app, page, "1062/add-live");
  await updateScenario({});
  await expect(page.getByRole("region", { name: "other-cloud", exact: true })).toBeVisible();
});

test("Hosts confirms stopping a running install before Settings closes and closes exited installs directly", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, card, calls, updateScenario } = await hostsFixture(context);
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  const dialog = page.getByRole("dialog", { name: "Stop the install?" });
  await updateScenario({ recipeInteractive: true });
  await card.getByRole("button", { name: "Install git", exact: true }).click();
  const terminal = card.getByRole("region", { name: "Install terminal" });
  await expect(terminal.locator(".xterm-screen")).toContainText("[sudo] password:");
  const id = await page.evaluate(
    async () => (await window.desktop.workspace()).terminals.at(-1).id,
  );
  await page.getByRole("button", { name: "Close settings (Esc)", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Keep open" })).toBeFocused();
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (mode) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${mode}` }),
      mode,
    );
    await expect
      .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
      .toBe(mode === "dark");
    await page.screenshot({ path: evidencePath(`1062/stop-install-${mode}.png`) });
  }
  await assertAccessible(page);
  await dialog.getByRole("button", { name: "Keep open" }).click();
  await expect(settings).toBeVisible();
  await expect(terminal.locator(".xterm-screen")).toContainText("[sudo] password:");
  assert.equal(
    await page.evaluate(
      async (id) =>
        (await window.desktop.workspace()).terminals.find((row) => row.id === id)?.exited === true,
      id,
    ),
    false,
  );
  // Settings-owned installs survive navigation to the selected machine in Agents.
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await page.getByRole("tab", { name: "Machines", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Machine", exact: true })
    .selectOption("host:fixture-cloud");
  const machineTerminal = page.getByRole("region", { name: "Install terminal", exact: true });
  await expect(machineTerminal.locator(".xterm-screen")).toContainText("[sudo] password:");
  await page.getByRole("tab", { name: "Global", exact: true }).click();
  await expect(machineTerminal).toHaveCount(0);
  await page.getByRole("tab", { name: "Machines", exact: true }).click();
  await expect(machineTerminal.locator(".xterm-screen")).toContainText("[sudo] password:");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeVisible();
  // The Settings shortcut and navigation away use the same gate.
  await boardCommand(app, ",", process.platform !== "darwin");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep open" }).click();
  await page.getByRole("button", { name: "Open message board", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("region", { name: "Message board", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Keep open" }).click();
  await page.locator(`[data-drag-session="${id}"]`).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.workspace())).terminals.some(
        (row) => row.id === id,
      ),
    )
    .toBe(false);
  await expect
    .poll(async () =>
      (await readFile(calls, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .some((entry) => entry.closed === id),
    )
    .toBe(true);
  await expect(page.locator(`[data-drag-session="${id}"]`)).toHaveCount(0);
  await expect(page.locator(".terminal-tile[data-kind='shell']")).toHaveCount(0);
  // Already-exited installs close immediately, without a stop dialog.
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Hosts", exact: true })
    .click();
  await updateScenario({ recipeImmediateExit: true });
  await card.getByRole("button", { name: "Install git", exact: true }).click();
  await expect(terminal.getByRole("status")).toHaveText("Done");
  const exitedId = await page.evaluate(
    async () => (await window.desktop.workspace()).terminals.at(-1).id,
  );
  await page.getByRole("button", { name: "Close settings (Esc)", exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.workspace())).terminals.some(
        (row) => row.id === exitedId,
      ),
    )
    .toBe(false);
});

test("Hosts reports recipes that exit in the creation frame and refreshes their tool", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { page, card, calls, updateScenario } = await hostsFixture(context);
  await updateScenario({ recipeImmediateExit: true });
  await card.getByRole("button", { name: "Install git", exact: true }).click();
  const terminal = card.getByRole("region", { name: "Install terminal" });
  await expect(terminal.getByRole("status")).toHaveText("Done");
  await expect(
    card
      .locator(".host-check-row")
      .filter({ has: page.getByRole("button", { name: "Reload git", exact: true }) }),
  ).toContainText("Pass · Installed");
  await expect
    .poll(
      async () =>
        (await readFile(calls, "utf8"))
          .split("\n")
          .filter((line) => line.includes('"target":{"kind":"tool","tool":"git"}')).length,
    )
    .toBe(1);
  await expect(terminal.locator(".xterm-screen")).toContainText("FIXTURE_RECIPE_COMPLETE");
});

test("Agents scopes use saved host observations and Global enablement without checks on navigation", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, card, calls, updateScenario } = await hostsFixture(context);
  await updateScenario({
    facts: {
      agents: [
        {
          id: "claude",
          state: "ready",
          signIn: "signed-in",
          details: {
            path: "/usr/local/bin/claude",
            version: "2.3.1",
            capabilities: ["Hooks", "MCP", "Resume"],
          },
        },
        { id: "codex", state: "missing" },
      ],
    },
  });
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  await expect(card.getByText("1 of 2 ready", { exact: true })).toBeVisible();
  // Join the sidebar invalidation from the explicit check before observing navigation.
  await page.evaluate(() => window.desktop.sidebarInventory());
  const before = (await readFile(calls, "utf8")).split("\n").filter(Boolean).length;
  await card.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Machines", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("region", { name: "Claude Code", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Global", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Enable Codex", exact: true })).toBeChecked();
  const afterNavigation = (await readFile(calls, "utf8")).split("\n").filter(Boolean);
  if (afterNavigation.length !== before)
    context.diagnostic(
      JSON.stringify({
        navigationRequests: afterNavigation.slice(before).map((line) => JSON.parse(line)),
      }),
    );
  assert.equal(afterNavigation.length, before);
  await expect(page.locator(".agent-global-row")).toHaveCount(6);
  await expect(page.locator(".agent-global-row .agent-status")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Machine", exact: true })).toHaveCount(0);
  await assertAccessible(page);
  await page.getByRole("checkbox", { name: "Enable Codex", exact: true }).uncheck();
  await page.getByRole("tab", { name: "Machines", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Machine", exact: true })
    .selectOption("host:fixture-cloud");
  await expect(page.getByRole("region", { name: "Codex", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Global", exact: true }).click();
  await page.getByRole("checkbox", { name: "Enable Codex", exact: true }).check();
  await page.getByRole("tab", { name: "Machines", exact: true }).click();
  await page.getByRole("combobox", { name: "Machine", exact: true }).selectOption("local");
  await expect(page.getByRole("region", { name: "Codex", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Re-check Codex", exact: true }).click();
  await expect(page.getByRole("button", { name: "Re-check Codex", exact: true })).toBeEnabled();
  assert.equal(
    await page.evaluate(() =>
      window.desktop.scanAgents(true, "unregistered-agent").then(
        () => false,
        () => true,
      ),
    ),
    true,
  );
  await page.getByRole("tab", { name: "Machines", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Machine", exact: true })
    .selectOption("host:fixture-cloud");
  await page.getByRole("button", { name: "Re-check Claude Code", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Re-check Claude Code", exact: true }),
  ).toBeEnabled();
  const requests = (await readFile(calls, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const latest = requests.filter(({ message }) => message.operation === "inspect").at(-1);
  assert.deepEqual(latest.message.target, { kind: "sign-in", tool: "claude" });
  await updateScenario({ inspectFailure: "unreachable" });
  await page.getByRole("button", { name: "Re-check fixture-cloud", exact: true }).click();
  await expect(page.getByText(/Offline · Last checked/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Re-check Claude Code", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("region", { name: "Claude Code", exact: true })).toContainText(
    "Signed in",
  );
  const folder = await page.evaluate(
    async () => (await window.desktop.setupState()).settings.registeredHosts[0].codeFolder,
  );
  await page.evaluate(() => window.desktop.hosts({ action: "remove", host: "fixture-cloud" }));
  // Replay the old machine request even if this window still holds its old snapshot.
  const beforeRemovedCheck = (await readFile(calls, "utf8")).split("\n").filter(Boolean).length;
  const refused = await page.evaluate(
    (codeFolder) =>
      window.desktop.hosts({ action: "preflight", host: "fixture-cloud", codeFolder }).then(
        () => false,
        () => true,
      ),
    folder,
  );
  assert.equal(refused, true);
  const dispatched = (await readFile(calls, "utf8"))
    .split("\n")
    .filter(Boolean)
    .slice(beforeRemovedCheck)
    .map((line) => JSON.parse(line));
  // A sidebar inspection already started before removal may still finish. It
  // does not request agentDetails; a full machine preflight always does.
  assert.deepEqual(
    dispatched.filter(
      ({ message }) =>
        message.operation === "inspect" && message.agentDetails === true && !message.target,
    ),
    [],
  );
  await updateScenario({});
  const draft = await page.evaluate(() =>
    window.desktop.hosts({
      action: "draft-preflight",
      host: "fixture-cloud",
      codeFolder: "~/foom",
    }),
  );
  assert.equal(draft.preflight.result.ok, true);
  assert.deepEqual(draft.hosts, []);
  assert.ok(app);
});

test("Agents scopes use trusted consent and fixed recipes for host plugin installation", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, card, calls, recipeCalls, updateScenario } = await hostsFixture(context);
  const agent = {
    id: "agy",
    state: "ready",
    details: {
      path: "/bin/agy",
      version: "1.4.12",
      capabilities: ["Resume"],
      plugin: "not-installed",
    },
  };
  await updateScenario({
    facts: { agents: [{ id: "claude", state: "ready" }, { id: "codex", state: "missing" }, agent] },
  });
  await card.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("tab", { name: "Global", exact: true }).click();
  await page.getByRole("checkbox", { name: "Enable Antigravity", exact: true }).check();
  await page.getByRole("tab", { name: "Machines", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Machine", exact: true })
    .selectOption("host:fixture-cloud");
  await page.getByRole("button", { name: "Re-check fixture-cloud", exact: true }).click();
  await page.getByRole("button", { name: "Install plugin", exact: true }).click();
  let disclosure = await confirmationPage(app);
  await expect(disclosure.getByRole("alertdialog")).toHaveAccessibleName(
    "Install Foom plugin on host?",
  );
  await expect(disclosure.getByRole("alertdialog")).toContainText("foom-host --stage-plugin agy");
  assert.equal(await readFile(recipeCalls, "utf8"), "");
  await disclosure.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Install plugin", exact: true })).toBeEnabled();
  assert.equal(await readFile(recipeCalls, "utf8"), "");
  // A live compatible daemon can still serve observations, but its bundled
  // plugin must not be installed under this desktop's approval.
  await updateScenario({
    compatibleBuild: true,
    facts: { agents: [agent] },
  });
  await page.getByRole("button", { name: "Install plugin", exact: true }).click();
  disclosure = await confirmationPage(app);
  await disclosure.getByRole("button", { name: "Install plugin", exact: true }).click();
  const failure = page.getByRole("dialog", { name: "Action failed", exact: true });
  await expect(failure).toBeVisible();
  assert.equal(await readFile(recipeCalls, "utf8"), "");
  await failure.getByRole("button", { name: "Dismiss", exact: true }).click();
  await updateScenario({ facts: { agents: [agent] } });
  await page.getByRole("button", { name: "Install plugin", exact: true }).click();
  disclosure = await confirmationPage(app);
  await disclosure.getByRole("button", { name: "Install plugin", exact: true }).click();
  await expect
    .poll(
      async () => (await readFile(recipeCalls, "utf8")).trim().split("\n").filter(Boolean).length,
    )
    .toBe(2);
  assert.deepEqual(
    (await readFile(recipeCalls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [
      ["foom-host", "--stage-plugin", "agy"],
      ["agy", "plugin", "install", "{stagedPlugin}"],
    ],
  );
  await expect(page.getByRole("region", { name: "Settings", exact: true })).toHaveCount(0);
  const checkpoint = (await readFile(calls, "utf8")).split("\n").filter(Boolean).length;
  await updateScenario({
    recipeExit: 0,
    facts: {
      agents: [
        { id: "claude", state: "ready" },
        { id: "codex", state: "missing" },
        { ...agent, details: { ...agent.details, plugin: "present" } },
      ],
    },
  });
  // Row refresh follows the reported PTY exit, rather than recipe creation.
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.workspace())).terminals.some(
        (row) => row.recipe && row.exited,
      ),
    )
    .toBe(true);
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await page.getByRole("tab", { name: "Machines", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Machine", exact: true })
    .selectOption("host:fixture-cloud");
  await expect(page.getByText("Present · use agy to manage", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install plugin", exact: true })).toHaveCount(0);
  const inspected = (await readFile(calls, "utf8"))
    .split("\n")
    .filter(Boolean)
    .slice(checkpoint)
    .map((line) => JSON.parse(line))
    .filter(({ message }) => message.operation === "inspect");
  assert.deepEqual(
    inspected.map(({ message }) => message.target),
    [
      { kind: "tool", tool: "agy" },
      { kind: "sign-in", tool: "agy" },
    ],
  );
});

test("Agents Global list and machine picker scale to twelve agents and twelve saved hosts", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "agents-picker-"));
  removeAfterApps(context, root);
  const home = path.join(root, "home");
  const profile = path.join(root, "profile");
  const bin = path.join(root, "bin");
  const manifests = path.join(home, ".foom", "config", "agents");
  await Promise.all([mkdir(manifests, { recursive: true }), mkdir(profile), mkdir(bin)]);
  const template = JSON.parse(
    await readFile(path.join(__dirname, "../fixtures/agent-plugin-v2.json"), "utf8"),
  );
  for (const [index, name] of [
    "Review",
    "Research",
    "Docs",
    "Infra",
    "Tests",
    "Release",
  ].entries()) {
    const id = `sample-${index}`;
    await writeFile(
      path.join(manifests, `${id}.json`),
      JSON.stringify({ ...template, id, name, executables: [id] }),
    );
  }
  const agents = [
    {
      id: "claude",
      state: "ready",
      signIn: "signed-in",
      details: {
        path: "/usr/local/bin/claude",
        version: "2.3.1",
        capabilities: ["Hooks", "MCP", "Resume"],
      },
    },
    { id: "codex", state: "missing" },
    {
      id: "agy",
      state: "ready",
      signIn: "signed-in",
      details: {
        path: "/usr/local/bin/agy",
        version: "1.4.12",
        capabilities: ["Resume"],
        plugin: "not-installed",
      },
    },
    {
      id: "copilot",
      state: "ready",
      signIn: "signed-out",
      details: { path: "/usr/local/bin/copilot", version: "0.0.351", capabilities: ["MCP"] },
    },
  ];
  const facts = {
    codeFolder: "/remote/code",
    version: "0.1.0",
    sessions: 0,
    cores: 8,
    load: [0, 0, 0],
    memoryTotal: 8000,
    memoryAvailable: 4000,
    requirements: { distro: "debian", libc: "supported", packageManager: "apt" },
    agents,
  };
  const result = { ok: true, facts };
  const registeredHosts = Array.from({ length: 12 }, (_, index) => ({
    host: `saved-machine-${index + 1}`,
    nickname: index === 11 ? "Archive" : `Build ${index + 1}`,
    codeFolder: "/remote/code",
    observation: {
      checkedAt: 1700000000000,
      lastAgents: { checkedAt: 1700000000000, result },
      preflight: {
        ssh: { state: "pass" },
        platform: { state: "pass" },
        artifact: { state: "pass" },
        repositories: [],
        result: index === 11 ? { ok: false, reason: "unreachable" } : result,
      },
    },
  }));
  await writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      version: 1,
      settings: {
        setupComplete: true,
        checkForUpdates: false,
        restoreSessions: false,
        registeredHosts,
        agents: { claude: true, codex: true, agy: true, copilot: true, opencode: true, pi: true },
      },
    }),
  );
  const app = await launchApp(context, {
    fixture: "empty-board",
    args: [`--user-data-dir=${profile}`],
    env: { HOME: home, PATH: bin },
  });
  const page = await boardPage(app);
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await expect(page.locator(".agent-global-row")).toHaveCount(12);
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.locator(".agent-global-row textarea")).toHaveCount(12);
  await expect(page.locator(".agent-manifest")).toHaveCount(6);
  await expect(page.getByRole("combobox", { name: "Machine" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Attach hooks" })).toBeVisible();
  const resize = async (width) => {
    await app.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      window.setMinimumSize(320, 400);
      window.setContentSize(width, 960);
    }, width);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
  };
  const capture = async (name, mode, width) => {
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    if (process.env.FOOM_AGENT_SCOPES_SCREENSHOTS === "1")
      await page.screenshot({ path: evidencePath(`1070-step2/${name}-${mode}-${width}.png`) });
  };
  const reviewCaptures = process.env.FOOM_AGENT_SCOPES_SCREENSHOTS === "1";
  for (const width of [1280, 480]) {
    await resize(width);
    const modes = reviewCaptures ? ["light", "dark"] : [width === 1280 ? "light" : "dark"];
    for (const mode of modes) {
      await page.evaluate(
        (mode) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${mode}` }),
        mode,
      );
      await expect
        .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
        .toBe(mode === "dark");
      await page.getByRole("tab", { name: "Global", exact: true }).click();
      await capture("global", mode, width);
      await page.getByRole("tab", { name: "Machines", exact: true }).click();
      const picker = page.getByRole("combobox", { name: "Machine", exact: true });
      await expect(picker.locator("option")).toHaveCount(13);
      if (width === 1280 && mode === "light") await expect(picker).toHaveValue("local");
      await expect(page.getByRole("checkbox", { name: "Attach hooks" })).toHaveCount(0);
      await picker.selectOption("local");
      await capture("machines", mode, width);
      await picker.selectOption("host:saved-machine-1");
      await expect(page.getByRole("region", { name: "Claude Code", exact: true })).toContainText(
        "2.3.1",
      );
      const codex = page.getByRole("region", { name: "Codex", exact: true });
      assert.equal(
        await codex
          .locator(".agent-status")
          .evaluate((element) => getComputedStyle(element).fontSize),
        "13px",
      );
      const signedOut = page
        .getByRole("region", { name: "GitHub Copilot", exact: true })
        .locator(".agent-status");
      await expect(signedOut).toHaveText("Signed out");
      await expect(signedOut.locator("svg circle")).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Install plugin", exact: true })).toBeEnabled();
      await capture("remote-plugin", mode, width);
      await picker.selectOption("host:saved-machine-12");
      await expect(page.getByText(/Offline · Last checked/)).toBeVisible();
      await expect(page.getByRole("region", { name: "Claude Code", exact: true })).toContainText(
        "2.3.1",
      );
      assert.equal(await page.locator(".agents-panel button:not(:disabled)").count(), 0);
      const list = page.getByRole("region", { name: "Machine agents", exact: true });
      await list.focus();
      await expect(list).toBeFocused();
      await page.keyboard.press("End");
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await page.keyboard.press("Home");
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0);
      await expect(page.getByText(/^Off:/)).toHaveCount(0);
      await capture("offline", mode, width);
    }
  }
  await assertAccessible(page);
});

test("Hosts accepts new SSH keys only through the trusted askpass dialog", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, card, capture, updateScenario, knownHosts, calls } = await hostsFixture(
    context,
    false,
    { sshFailure: "unknown" },
  );
  const trust = card.getByRole("button", { name: "Trust host key…", exact: true });
  await expect(trust).toBeEnabled();
  await expect(card.locator(".host-check-row")).toHaveCount(1);
  for (const text of [
    "Platform",
    "Remote daemon",
    "Code folder",
    "git / gh",
    "Agents",
    "Git access to origin",
    "Checked out repositories",
    "Host facts",
  ]) {
    await expect(card.getByText(text, { exact: true })).toHaveCount(0);
  }
  await expect(card.locator(".host-repositories, .host-footer, .host-details")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
  await expect(card.getByRole("region", { name: "Host check output", exact: true })).toBeVisible();
  assert.equal(
    (await readFile(calls, "utf8")).trim(),
    "",
    "No daemon or repository request before SSH trust",
  );
  const state = await page.evaluate(() => window.desktop.hosts({ action: "list" }));
  assert.deepEqual(state.hosts[0].observation.preflight.repositories, []);
  const waitingOutput = card.getByRole("region", { name: "Host check output", exact: true });
  await expect(waitingOutput.getByRole("status")).toHaveText("Host key not trusted");
  await expect(waitingOutput.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
  const screenshots = process.env.FOOM_HOST_KEY_SCREENSHOTS === "1";
  if (screenshots) await capture("1059/round4-untrusted-card");
  const dialog = await confirmationPage(app);
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (mode) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${mode}` }),
      mode,
    );
    await expect(waitingOutput.getByRole("status")).toHaveCSS(
      "color",
      mode === "light" ? "rgb(140, 80, 0)" : "rgb(255, 178, 62)",
    );
    await expect(trust).toHaveCSS(
      "background-color",
      mode === "light" ? "rgb(91, 43, 217)" : "rgb(155, 107, 255)",
    );
    for (const name of ["SSH"]) {
      const row = card
        .locator(".host-check-row")
        .filter({ has: page.getByText(name, { exact: true }) });
      const status = row.locator(".host-status");
      await expect(status).toHaveClass(/host-need/u);
      await expect(status).toHaveCSS(
        "color",
        mode === "light" ? "rgb(140, 80, 0)" : "rgb(255, 178, 62)",
      );
      const marker = status.locator(".host-symbol");
      await expect(marker).toHaveText("");
      await expect(marker).toHaveCSS("border-radius", "50%");
      await expect(marker).not.toHaveCSS("box-shadow", "none");
      await expect(marker).toHaveCSS(
        "background-color",
        mode === "light" ? "rgb(217, 130, 0)" : "rgb(255, 178, 62)",
      );
    }
    await trust.click();
    await expect(
      dialog.getByRole("heading", { name: "Trust host key?", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await expect(
      dialog.getByText(
        "Compare this fingerprint with a trusted source before accepting. OpenSSH will save this key in known_hosts.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(dialog.getByText(`SHA256:${"a".repeat(43)}`, { exact: true })).toBeVisible();
    if (screenshots)
      await dialog.screenshot({ path: evidencePath(`1059/trust-dialog-${mode}.png`) });
    await dialog.keyboard.press("Escape");
    await expect(trust).toBeEnabled();
    assert.equal(await readFile(knownHosts, "utf8"), "");
  }
  await trust.click();
  await dialog.getByRole("button", { name: "Trust host key", exact: true }).click();
  await expect(card.getByText("Pass · Host key trusted", { exact: true })).toBeVisible();
  assert.equal(await readFile(knownHosts, "utf8"), "fixture-cloud fixture-key\n");
  await expect(card.getByRole("region", { name: "Host check output", exact: true })).toBeVisible();
  for (const text of [
    "Platform",
    "Remote daemon",
    "Code folder",
    "Agents",
    "Checked out repositories",
    "Host facts",
  ]) {
    await expect(card.getByText(text, { exact: true }).first()).toBeVisible();
  }
  await expect(card.locator(".host-footer")).toBeVisible();
  assert.ok((await readFile(calls, "utf8")).includes('"operation":"inspect"'));
  if (screenshots) await capture("1059/accepted-key-row");
  await updateScenario({ sshFailure: "changed" });
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(card.getByText("Host key changed", { exact: true }).first()).toBeVisible();
  const changedStatuses = card.locator(".host-status").filter({ hasText: "Host key changed" });
  await expect(waitingOutput.getByRole("status")).toHaveText("Failed");
  await expect(waitingOutput.getByRole("status")).toHaveCSS("color", "rgb(255, 46, 136)");
  await expect(waitingOutput.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
  await expect(changedStatuses).toHaveCount(1);
  for (const status of await changedStatuses.all()) {
    await expect(status).toHaveClass(/host-fail/u);
    await expect(status.locator(".host-symbol")).toHaveText("×");
  }
  await expect(trust).toHaveCount(0);
  assert.equal(await readFile(knownHosts, "utf8"), "fixture-cloud fixture-key\n");
  await updateScenario({ loginRejected: true });
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(card.getByText("Login rejected", { exact: true }).first()).toBeVisible();
  await expect(trust).toHaveCount(0);
});

test("Hosts keeps an accepted key when the first recheck rejects login and offers the old-client fallback", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, card, updateScenario, knownHosts } = await hostsFixture(context, false, {
    sshFailure: "unknown",
    oldSsh: true,
  });
  await expect(card.getByRole("button", { name: "Trust host key…", exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Copy SSH command", exact: true })).toBeVisible();
  await updateScenario({ sshFailure: "unknown", loginRejected: true });
  await card.getByRole("button", { name: "Reload SSH", exact: true }).click();
  await card.getByRole("button", { name: "Trust host key…", exact: true }).click();
  const dialog = await confirmationPage(app);
  await dialog.getByRole("button", { name: "Trust host key", exact: true }).click();
  await expect(card.getByText("Login rejected", { exact: true }).first()).toBeVisible();
  assert.equal(await readFile(knownHosts, "utf8"), "fixture-cloud fixture-key\n");
  await expect(card.getByRole("button", { name: "Trust host key…", exact: true })).toHaveCount(0);
});

test("Hosts never offers host-key trust from a remote command's forged SSH diagnostic", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { card, page, updateScenario } = await hostsFixture(context, false);
  for (const remoteHostKeyExit of [1, 255]) {
    await updateScenario({ remoteHostKeyExit });
    await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
    await expect(
      card.getByText("Host unreachable · unreachable", { exact: true }).first(),
    ).toBeVisible();
    // The row can show progress before the completed result replaces saved facts.
    await expect(
      card.getByRole("button", { name: "Check capabilities", exact: true }),
    ).toBeEnabled();
    await expect(card.locator(".host-checks")).toHaveAttribute("aria-busy", "false");
    await expect(card.getByRole("button", { name: "Trust host key…", exact: true })).toHaveCount(0);
    const state = await page.evaluate(() => window.desktop.hosts({ action: "list" }));
    assert.equal(state.hosts[0].result.connection.ssh.reason, "unreachable");
  }
});

test("Hosts kills fixture SSH on live diagnostic overflow and removes its private file", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { card, page, updateScenario, overflowInfo } = await hostsFixture(context, false);
  await updateScenario({ diagnosticOverflow: true });
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(
    card.getByText("Host unreachable · unreachable", { exact: true }).first(),
  ).toBeVisible();
  // Checklist and background inventory probes finish independently. Wait for
  // the run, then observe cleanup for every fixture process instead of racing
  // the first failed row or checking only the last recorded process.
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  const probes = (await readFile(overflowInfo, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(probes.length > 0);
  for (const { diagnostic, pid } of probes) {
    await expect
      .poll(async () => {
        try {
          await access(diagnostic);
          return false;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          return true;
        }
      })
      .toBe(true);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
  await expect(card.getByRole("button", { name: "Trust host key…", exact: true })).toHaveCount(0);
  const state = await page.evaluate(() => window.desktop.hosts({ action: "list" }));
  assert.equal(state.hosts[0].result.connection.ssh.reason, "unreachable");
});

test("Hosts folder-change alerts keep unknown SSH keys in the needs-you tone", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { page, card, updateScenario } = await hostsFixture(context, false);
  await updateScenario({ sshFailure: "unknown" });
  await card.getByRole("button", { name: "Change folder", exact: true }).click();
  await page.getByLabel("Code folder", { exact: true }).fill("~/another");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Host key not trusted" });
  await expect(alert).toBeVisible();
  await expect(alert.locator(".host-status")).toHaveClass(/host-need/u);
  await expect(alert.locator(".host-symbol")).toHaveText("");
});

test("Hosts removal prunes saved session rows and startup repairs already forgotten hosts", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const fixture = await hostsFixture(context);
  const profile = await fixture.app.evaluate(({ app }) => app.getPath("userData"));
  const repository = await fixture.page.evaluate(
    async () => (await window.desktop.workspace()).repositories[0].path,
  );
  await fixture.page.evaluate(() => window.desktop.saveSetup({ restoreSessions: false }));
  await quitAndWait(fixture.app, () => fixture.app.evaluate(({ app }) => app.quit()));
  const saved = {
    id: "forgotten-host-session",
    agent: "claude",
    repository,
    worktree: repository,
    branch: "main",
    running: false,
    remote: true,
    placement: { kind: "remote", host: "fixture-cloud" },
  };
  const sessionsFile = path.join(profile, "sessions.json");
  await writeFile(sessionsFile, JSON.stringify([saved]));
  const options = {
    fixture: "restored",
    args: [`--user-data-dir=${profile}`],
    env: { PATH: fixture.bin },
  };
  const app = await launchApp(context, options);
  const page = await boardPage(app);
  const rows = (page) =>
    page.evaluate(async () => (await window.desktop.workspace()).terminals.map((row) => row.id));
  await expect.poll(() => rows(page)).toEqual([saved.id]);
  await expect(page.locator(`[data-drag-session="${saved.id}"]`)).toBeVisible();
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Hosts", exact: true })
    .click();
  const card = page.getByRole("region", { name: "fixture-cloud", exact: true });
  await expect(card.locator(".host-checks")).toHaveAttribute("aria-busy", "false");
  // Drain startup sidebar discovery before measuring requests caused by Forget.
  await page.evaluate(() => window.desktop.sidebarInventory());
  // Take the baseline only after consecutive polls observe a settled call log.
  let callsBefore;
  await expect
    .poll(
      async () => {
        const calls = await readFile(fixture.calls, "utf8");
        const settled = calls === callsBefore;
        callsBefore = calls;
        return settled;
      },
      { intervals: [500] },
    )
    .toBe(true);
  await card.getByRole("button", { name: "Remove", exact: true }).click();
  await expect.poll(() => rows(page)).toEqual([]);
  await expect(page.locator(`[data-drag-session="${saved.id}"]`)).toHaveCount(0);
  await expect.poll(async () => JSON.parse(await readFile(sessionsFile, "utf8"))).toEqual([]);
  // Include the inventory refresh published by removal in the no-SSH assertion.
  await page.evaluate(() => window.desktop.sidebarInventory());
  assert.equal(
    await readFile(fixture.calls, "utf8"),
    callsBefore,
    "Forgetting never contacts SSH or closes a session",
  );
  await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
  assert.equal(
    await readFile(fixture.calls, "utf8"),
    callsBefore,
    "Forgetting must not leave SSH or close calls running after removal",
  );
  const restarted = await launchApp(context, options);
  const restartedPage = await boardPage(restarted);
  await expect.poll(() => rows(restartedPage)).toEqual([]);
  await quitAndWait(restarted, () => restarted.evaluate(({ app }) => app.quit()));
  // Reproduce a profile written by an older build: no registration, but a saved row.
  await writeFile(sessionsFile, JSON.stringify([saved]));
  const stale = await launchApp(context, options);
  const stalePage = await boardPage(stale);
  await expect.poll(() => rows(stalePage)).toEqual([]);
  await expect(stalePage.locator(`[data-drag-session="${saved.id}"]`)).toHaveCount(0);
  await expect.poll(async () => JSON.parse(await readFile(sessionsFile, "utf8"))).toEqual([]);
});

test("Hosts real OpenSSH client shows a visible trust dialog for a disposable loopback sshd", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const fixture = await require("./real-ssh-fixture.js").realSshFixture(context);
  if (!fixture) return;
  // start:fresh may have no same-revision remote catalog. That local failure
  // must not replace the explicit unknown-key observation before the click.
  const metadata = path.resolve("build/build-metadata.json");
  const previous = await readFile(metadata);
  fixtureCleanup(context).apps.push(() => writeFile(metadata, previous));
  await writeFile(
    metadata,
    JSON.stringify({ ...JSON.parse(previous), remoteHostsAvailable: false }),
  );
  const app = await launchApp(context, { fixture: "empty-board", env: { PATH: fixture.bin } });
  const page = await boardPage(app);
  await page.evaluate(async () => {
    await window.desktop.hosts({ action: "add", host: "loopback-fixture", codeFolder: "/code" });
    await window.desktop.hosts({
      action: "preflight",
      host: "loopback-fixture",
      codeFolder: "/code",
    });
  });
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Hosts", exact: true })
    .click();
  const card = page.getByRole("region", { name: "loopback-fixture", exact: true });
  await expect(card.getByText("Host key not trusted", { exact: true }).first()).toBeVisible();
  await expect(card.locator(".host-check-row")).toHaveCount(1);
  await card.getByRole("button", { name: "Trust host key…", exact: true }).click();
  const dialog = await confirmationPage(app);
  await expect(dialog.getByRole("heading", { name: "Trust host key?", exact: true })).toBeVisible();
  await expect(dialog.getByText(`[127.0.0.1]:${fixture.port}`, { exact: true })).toBeVisible();
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://confirmation/confirmation.html")
        .isVisible(),
    ),
    true,
  );
  await dialog.getByRole("button", { name: "Trust host key", exact: true }).click();
  // With all authentication disabled, OpenSSH saves the explicitly accepted key
  // then the normal first check reports the authentication refusal. OpenSSH uses an
  // empty method list here (Permission denied ()), which retains the existing
  // conservative unreachable classification.
  await expect(
    card.getByText("Host unreachable · unreachable", { exact: true }).first(),
  ).toBeVisible();
  assert.ok((await readFile(fixture.knownHosts, "utf8")).includes("ssh-ed25519"));
  await expect(card.getByText("Platform", { exact: true })).toBeVisible();
});

test("Hosts shows a fixed trust failure when askpass refuses an unrecognized prompt", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, card, updateScenario, knownHosts } = await hostsFixture(context, false, {
    sshFailure: "unknown",
  });
  await updateScenario({ sshFailure: "unknown", badPrompt: "Password: FIXTURE_PRIVATE_PROMPT" });
  await card.getByRole("button", { name: "Trust host key…", exact: true }).click();
  const output = card.getByRole("region", { name: "Host check output", exact: true });
  await expect(
    output.getByText("Unable to trust host key · askpass-prompt-rejected", { exact: true }),
  ).toBeVisible();
  await expect(output).not.toContainText("FIXTURE_PRIVATE_PROMPT");
  const dialog = await confirmationPage(app);
  await expect(dialog.getByRole("heading", { name: "Trust host key?", exact: true })).toHaveCount(
    0,
  );
  assert.equal(await readFile(knownHosts, "utf8"), "");
  await expect(card.getByRole("button", { name: "Trust host key…", exact: true })).toBeEnabled();
});

test("Hosts reports dialog-unavailable when native trust presentation fails", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, card, knownHosts } = await hostsFixture(context, false, { sshFailure: "unknown" });
  await app.evaluate(({ BrowserWindow }) => {
    const dialog = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://confirmation/confirmation.html",
    );
    dialog.show = () => {
      throw new Error("Fixture native presentation failure");
    };
  });
  await card.getByRole("button", { name: "Trust host key…", exact: true }).click();
  const output = card.getByRole("region", { name: "Host check output", exact: true });
  await expect(
    output.getByText("Unable to trust host key · dialog-unavailable", { exact: true }),
  ).toBeVisible();
  await expect(output).not.toContainText("Fixture native presentation failure");
  await expect(card.getByRole("button", { name: "Trust host key…", exact: true })).toBeEnabled();
  assert.equal(await readFile(knownHosts, "utf8"), "");
});
