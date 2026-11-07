const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { gzipSync } = require("node:zlib");
const { mkdir, mkdtemp, readFile, writeFile, rename, rm } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { gitSync } = require("../helpers/git.js");
const { evidencePath } = require("../helpers/evidence.js");
const { deadline, expect } = require("./test-policy.js");
const {
  boardPage,
  fixtureCleanup,
  launchApp,
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
        path: evidencePath(`${name.startsWith("1061/") ? name : `1063/${name}`}-${mode}.png`),
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

async function hostsFixture(context, captureEnrollment = false) {
  const root = await mkdtemp(path.join(tmpdir(), "hosts-settings-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const calls = path.join(root, "calls.jsonl");
  const recipeCalls = path.join(root, "recipes.jsonl");
  const scenario = path.join(root, "scenario.json");
  await writeFile(scenario, "{}");
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
for (const flag of ['BatchMode=yes','ClearAllForwardings=yes','ForwardAgent=no','ForwardX11=no','ConnectTimeout=10']) assert.ok(args.includes(flag));
const split = args.indexOf('--'); const host = args[split+1];
assert.ok(['fixture-cloud','other-cloud','offline-cloud','version-cloud','invalid-cloud','provider-cloud','configuration-cloud','cancelled-cloud'].includes(host));
if (host === 'offline-cloud') { process.stderr.write('RAW SSH SECRET'); process.exit(1); }
if (args.at(-1) === 'uname -s; uname -m') { process.stdout.write(${JSON.stringify(`${platform === "darwin" ? "Darwin" : "Linux"}\n${process.arch === "x64" ? "x86_64" : platform === "darwin" ? "arm64" : "aarch64"}\n`)}); process.exit(0); }
// Standalone fixed libc preflight has no daemon protocol handshake.
if (args.at(-1).includes('FOOM-LIBC-UNSUPPORTED') && !args.at(-1).includes('FOOM-READY')) { if(require('node:fs').readFileSync(${JSON.stringify(scenario)},'utf8').includes('musl')) { process.stdout.write('FOOM-LIBC-UNSUPPORTED'); process.exit(1); } process.exit(0); }
process.stdout.write('FOOM-READY\\n');
let input=Buffer.alloc(0), terminalOutput='';
const {spawnSync}=require('node:child_process');
const {selectHostRecipe}=require(${JSON.stringify(path.resolve("build/shared/registered-host-recipes.js"))});
function send(message) { const data=Buffer.from(JSON.stringify({version:3,message})); const head=Buffer.alloc(4); head.writeUInt32BE(data.length); process.stdout.write(Buffer.concat([head,data])); }
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
    assert.ok(recipe); assert.equal(recipe.steps.length,1);
    const child=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(recipeFixture)},...recipe.steps[0]],{env:{},encoding:'utf8'});
    assert.equal(child.status,0); terminalOutput=child.stdout;
    send({type:'open-result',id:message.id,request:message.request,state:'live'});continue;
  }
  if('id' in message) {
    if(message.type==='attach')send({type:'data',id:message.id,view:message.view,token:'fixture-recipe',data:terminalOutput});
    send({type:'result',id:message.id,request:message.request,lines:terminalOutput.split('\\r\\n'),cols:80,rows:24,title:'Recipe'});
    continue;
  }
  assert.equal('id' in message,false); appendFileSync(${JSON.stringify(calls)},JSON.stringify({host,message})+'\\n');
  if(message.type==='hello') { send({type:'hello',build:host==='version-cloud'?'b'.repeat(64):${JSON.stringify(manifest.sha256)}}); continue; }
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
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  await expect(card.getByText("Pass · Host key trusted", { exact: true })).toBeVisible();
  await expect(card.getByText("Not found", { exact: true })).toHaveCount(2);
  await expect(card.getByRole("button", { name: "Install codex", exact: true })).toHaveCount(0);
  await expect(card.getByText("Not checked", { exact: true })).toHaveCount(1);
  if (captureEnrollment) await capture("partial-facts");
  return {
    app,
    page,
    card,
    navigation,
    progressStatus,
    capture,
    updateScenario,
    heldCloneCount,
    platform,
    catalog,
    compressed,
    calls,
    cloneReason,
    recipeCalls,
  };
}

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
  await expect(checkoutRow).toContainText("Checking…");
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
  await checkoutRow.screenshot({ path: evidencePath("1041/check-row-spinner.png") });
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
  await expect(checkoutRow).toContainText("Checking…");
  await capture("progress-checkout-reduced");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await capture("progress-checkout");
  await updateScenario({ ...checkingOrigin, hold: false });
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  await expect(card.locator(".host-throbber")).toHaveCount(0);
  await expect(checkoutRow).toContainText("Not checked out");
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

test("Hosts shows readiness and clones checkouts with explicit origin trust", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, card, capture, updateScenario, heldCloneCount, calls } =
    await hostsFixture(context);
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
  await expect(card.getByText("Ready · 1 repository", { exact: true })).toBeVisible();
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
  await expect(card.getByText("Ready · 0 repositories", { exact: true })).toBeVisible();
  assert.equal(
    await card
      .getByText("Not checked out", { exact: true })
      .evaluate((el) => el.closest(".host-status").classList.contains("host-neutral")),
    true,
  );
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
  const heldHostClones = await heldCloneCount();
  await updateScenario({ ...optional, holdClone: true });
  await card.getByRole("button", { name: "Clone here", exact: true }).click();
  await expect(card.getByText("Cloning…", { exact: true })).toBeVisible();
  await capture("hosts-cloning");
  await expect.poll(heldCloneCount).toBe(heldHostClones + 1);
  await updateScenario({ ...optional, checkout: "clean" });
  await expect(
    card.getByText("Origin authentication failed · origin-auth", { exact: true }),
  ).toBeVisible();
  await capture("hosts-clone-failed");
  await updateScenario({ ...optional, cloneSuccess: true, checkout: "clean" });
  await card.getByRole("button", { name: "Clone here", exact: true }).click();
  await expect(card.getByRole("button", { name: /Repositories · 1 ready/ })).toBeVisible();
  await card.getByRole("button", { name: /Repositories · 1 ready/ }).click();
  await expect(card.getByText("Clean", { exact: true })).toBeVisible();
  await capture("hosts-clone-clean");
  await updateScenario({ ...optional, origin: "origin-host-key" });
  await card.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(card.getByRole("button", { name: "Trust host key", exact: true })).toBeEnabled();
  await capture("origin-host-key");
  const beforeTrust = (await readFile(calls, "utf8")).trim().split("\n").length;
  await card.getByRole("button", { name: "Trust host key", exact: true }).click();
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
  await expect(card.getByText("Ready · 1 repository", { exact: true })).toBeVisible();
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

test("Repositories clones per host and opens fixed repair recipes without exposing remote output", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const {
    page,
    card,
    navigation,
    calls,
    cloneReason,
    recipeCalls,
    capture,
    updateScenario,
    heldCloneCount,
  } = await hostsFixture(context);
  await card.getByRole("button", { name: "Change folder", exact: true }).click();
  await card.getByLabel("Code folder", { exact: true }).fill("~/new-code");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  await navigation.getByRole("button", { name: "Repositories", exact: true }).click();
  await expect(page.getByRole("region", { name: "Local", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clone here", exact: true })).toHaveCount(1);
  const heldRepositoryClones = await heldCloneCount();
  await updateScenario({ holdClone: true, cloneSuccess: true });
  await page.getByRole("button", { name: "Clone here", exact: true }).click();
  await expect(page.getByText("Cloning…", { exact: true })).toBeVisible();
  await capture("repositories-cloning");
  // Each optimistic clone waits for its own held reply, not an earlier clone.
  await expect.poll(heldCloneCount).toBe(heldRepositoryClones + 1);
  await updateScenario({});
  await expect(page.getByText("Clean", { exact: true })).toBeVisible();
  await capture("repositories-clone-clean");
  await page.getByRole("button", { name: "Refresh locations", exact: true }).click();
  await expect(page.getByText("Not checked out", { exact: true })).toBeVisible();
  for (const [reason, text] of [
    ["origin-auth", "Origin authentication failed"],
    ["origin-host-key", "Origin SSH host key is not trusted"],
    ["origin-unreachable", "Origin unreachable"],
    ["timed-out", "Git operation timed out"],
    ["checkout-invalid", "Checkout validation failed"],
  ]) {
    await writeFile(cloneReason, reason);
    await page.getByRole("button", { name: "Clone here", exact: true }).click();
    await expect(page.getByText(`${text} · ${reason}`, { exact: true })).toBeVisible();
  }
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
    .toBe(1);
  await expect(page.locator(".terminal-tile[data-kind='shell']").last()).toBeVisible();
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
    facts: {
      tools: [
        { id: "git", state: "ready", signIn: "unknown" },
        { id: "gh", state: "ready", signIn: "signed-out" },
      ],
    },
  });
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
    .toBe(2);
  assert.deepEqual(
    (await readFile(recipeCalls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [
      ["/usr/bin/sudo", "/usr/bin/apt-get", "install", "-y", "git"],
      ["gh", "auth", "login", "--web", "--git-protocol", "https", "--skip-ssh-key"],
    ],
  );
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
  assert.ok(recorded.some(({ message }) => message.operation === "clone"));
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
  await expect(card.getByText("Ready · 6 repositories", { exact: true })).toBeVisible();
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
  await card.getByRole("button", { name: /Repositories · 6 ready/ }).click();
  await expect(card.getByText("Clean", { exact: true })).toHaveCount(6);
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
    await card.getByRole("button", { name: /Repositories · 6 ready/ }).click();
    await assertHostColumns(card);
    await capture(`expanded-${width}`);
    await card.getByRole("button", { name: /Repositories · 6 ready/ }).click();
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(1280, 800),
  );
  await card.getByRole("button", { name: /Repositories · 6 ready/ }).click();
  await card.getByText("Host facts", { exact: true }).click();
  await expect(card.getByText("Other profiles or untagged: 2", { exact: true })).toBeVisible();
  await capture("inventory");
  await assertAccessible(page);
  assert.equal(await readFile(calls, "utf8"), before);
  await navigation.getByRole("button", { name: "General", exact: true }).click();
  await navigation.getByRole("button", { name: "Hosts", exact: true }).click();
  await expect(card.getByText("Ready · 6 repositories", { exact: true })).toBeVisible();
  assert.equal(await readFile(calls, "utf8"), before);
});

test("Hosts reloads individual rows and actions never trigger full capability checks", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, card, calls, updateScenario } = await hostsFixture(context);
  const managementCalls = async () =>
    (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(
        ({ message, phase }) =>
          message.type === "manage" && message.operation !== "list-worktrees" && !phase,
      )
      .map(({ message }) => message);
  const checkedAt = () =>
    page.evaluate(
      async () =>
        (await window.desktop.setupState()).settings.registeredHosts[0].observation.checkedAt,
    );
  const timestamp = await checkedAt();
  let before = (await managementCalls()).length;
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
  const afterReload = (await managementCalls()).slice(before);
  assert.equal(afterReload.length, 1);
  assert.deepEqual(afterReload[0].target, { kind: "tool", tool: "git" });
  // The fixture returned changed gh facts too. Its row must retain its prior result.
  await expect(card.getByRole("button", { name: "Sign in gh", exact: true })).toBeVisible();
  assert.equal(await checkedAt(), timestamp);
  await captureHosts(app, page, "1061/row-reload-complete");
  before = (await managementCalls()).length;
  await card.getByRole("button", { name: "Change folder", exact: true }).click();
  await card.getByLabel("Code folder", { exact: true }).fill("~/new-code");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByRole("button", { name: "Check capabilities", exact: true })).toBeEnabled();
  assert.deepEqual(
    (await managementCalls()).slice(before).map(({ operation, target }) => ({ operation, target })),
    [{ operation: "inspect", target: { kind: "folder" } }],
  );
  await expect(
    card.locator(".host-check-row").filter({ hasText: "Repository checkout" }),
  ).toContainText("Not checked");
  assert.equal(await checkedAt(), timestamp);
  // A row reload can reconcile a missing folder, then Create uses only its own reply.
  await updateScenario({ facts: { folder: { state: "fail", reason: "folder-missing" } } });
  await card.getByRole("button", { name: "Reload Code folder", exact: true }).click();
  await expect(card.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
  await updateScenario({});
  before = (await managementCalls()).length;
  await card.getByRole("button", { name: "Create", exact: true }).click();
  await expect(card.getByText("Pass · Valid", { exact: true })).toBeVisible();
  assert.deepEqual(
    (await managementCalls()).slice(before).map(({ operation }) => operation),
    ["create-folder"],
  );
  assert.equal(await checkedAt(), timestamp);
  // Checkout reload and Clone do not inspect other repositories or capabilities.
  await card.getByRole("button", { name: /^Reload Repository checkout/u }).click();
  await expect(card.getByRole("button", { name: "Clone here", exact: true })).toBeEnabled();
  before = (await managementCalls()).length;
  await card.getByRole("button", { name: "Clone here", exact: true }).click();
  await expect(
    card.getByText("Origin authentication failed · origin-auth", { exact: true }),
  ).toBeVisible();
  assert.deepEqual(
    (await managementCalls()).slice(before).map(({ operation }) => operation),
    ["clone"],
  );
  assert.equal(await checkedAt(), timestamp);
  await card.getByText("Host facts", { exact: true }).click();
  await updateScenario({ facts: { cores: 4 } });
  before = (await managementCalls()).length;
  await card.getByRole("button", { name: "Refresh facts", exact: true }).click();
  await expect(card.getByText("CPU cores", { exact: true }).locator("..")).toContainText("4");
  await expect(card.getByRole("button", { name: "Refresh facts", exact: true })).toBeEnabled();
  assert.deepEqual(
    (await managementCalls()).slice(before).map(({ operation, target }) => ({ operation, target })),
    [{ operation: "inspect", target: { kind: "facts" } }],
  );
  assert.equal(await checkedAt(), timestamp);
  await updateScenario({ factsFailure: "unreachable" });
  before = (await managementCalls()).length;
  await card.getByRole("button", { name: "Refresh facts", exact: true }).click();
  await expect(card.getByText("Host unreachable", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Refresh facts", exact: true })).toBeEnabled();
  assert.deepEqual(
    (await managementCalls()).slice(before).map(({ operation, target }) => ({ operation, target })),
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
