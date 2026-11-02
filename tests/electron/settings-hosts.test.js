const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { gzipSync } = require("node:zlib");
const { mkdir, mkdtemp, readFile, writeFile, rm } = require("node:fs/promises");
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

test("Settings authorizes checked SSH hosts and shows repository locations without exposing remote output", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "hosts-settings-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const calls = path.join(root, "calls.jsonl");
  const recipeCalls = path.join(root, "recipes.jsonl");
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
  let result;
  if(message.codeFolder==='~/unsafe') result={ok:false,reason:'unsafe-folder'};
  else if(message.codeFolder==='~/refused') result={ok:false,reason:'folder-refused'};
  else if(message.operation==='clone' && host==='fixture-cloud') {process.stderr.write('RAW GIT SECRET');result={ok:false,reason:require('node:fs').readFileSync(${JSON.stringify(cloneReason)},'utf8')};}
  else {
   const folder=message.codeFolder.startsWith('~/')?'/remote/account/'+message.codeFolder.slice(2):message.codeFolder;
   result={ok:true,facts:{codeFolder:folder,version:${JSON.stringify(manifest.version)},sessions:2,cores:8,load:[0.42,0.31,0.25],memoryTotal:17179869184,memoryAvailable:11811160064,requirements:{distro:'debian',libc:'supported',packageManager:'apt'},tools:[{id:'git',state:'missing',signIn:'unknown'},{id:'gh',state:'ready',signIn:'signed-out'}],agents:[{id:'claude',state:'ready'},{id:'codex',state:'missing'},{id:'agy',state:'unable'}]}};
   if(message.operation==='repository' || message.operation==='clone') result.checkout={path:folder+'/'+message.directory,state:message.operation==='clone'?'clean':'absent'};
  }
  if(host==='invalid-cloud') result={ok:true,facts:{}};
  const failures={'provider-cloud':'provider-invalid','configuration-cloud':'configuration-changed','cancelled-cloud':'cancelled'};
  if(failures[host]) result={ok:false,reason:failures[host]};
  send({type:'managed',result});
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
      .setContentSize(1280, 960),
  );
  const page = await boardPage(app);
  const repository = await page.evaluate(
    async () => (await window.desktop.workspace()).repositories[0].path,
  );
  gitSync(["remote", "add", "origin", "git@forge.test:team/project.git"], { cwd: repository });
  const assertHostColumns = async () => {
    const rows = await page
      .getByRole("region", { name: "fixture-cloud", exact: true })
      .locator(".host-agents > li")
      .evaluateAll((rows) =>
        rows.map((row) => ({
          width: row.clientWidth,
          scrollWidth: row.scrollWidth,
          cells: [...row.children].map((cell) => ({
            x: cell.getBoundingClientRect().x,
            text: cell.textContent,
            buttonX: cell.querySelector("button")?.getBoundingClientRect().x,
          })),
        })),
      );
    assert.ok(rows.length >= 4);
    for (const row of rows) {
      assert.equal(row.cells.length, 4);
      assert.ok(row.scrollWidth <= row.width + 1);
      for (let column = 0; column < 4; column++)
        assert.ok(Math.abs(row.cells[column].x - rows[0].cells[column].x) < 1);
      if (row.cells[3].buttonX !== undefined)
        assert.ok(Math.abs(row.cells[3].buttonX - row.cells[3].x) < 1);
    }
    assert.equal(rows.find((row) => row.cells[0].text === "git").cells[2].text, "");
    assert.equal(rows.find((row) => row.cells[0].text === "claude").cells[3].text, "");
    assert.match(
      rows.find((row) => row.cells[0].text === "codex").cells[3].text,
      /^Install unavailable/u,
    );
  };
  const capture = async (name) => {
    for (const mode of ["light", "dark"]) {
      await page.evaluate(
        (mode) =>
          window.desktop.saveSetup({
            interfaceTheme: mode === "light" ? "eclipse-light" : "eclipse-dark",
          }),
        mode,
      );
      await expect
        .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
        .toBe(mode === "dark");
      if (["host-facts-agents", "host-recipes"].includes(name)) await assertHostColumns();
      await page.screenshot({
        path: evidencePath(
          `${name.startsWith("1004-") ? "1004" : "screenshots-757"}/${name}-${mode}.png`,
        ),
      });
    }
  };
  await openSettingsScreen(page);
  const navigation = page.getByRole("navigation", { name: "Settings sections" });
  await navigation.getByRole("button", { name: "Hosts", exact: true }).click();
  await expect(page.getByText("No hosts", { exact: true })).toBeVisible();
  await capture("hosts-empty");
  await page.getByRole("button", { name: "Add host", exact: true }).click();
  await page.getByLabel("SSH host", { exact: true }).fill("offline-cloud");
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(page.getByText("Host unreachable", { exact: true })).toBeVisible();
  await capture("995-after-unreachable");
  assert.equal(
    (await page.evaluate(() => window.desktop.setupState())).settings.registeredHosts,
    undefined,
  );
  await page.getByLabel("SSH host", { exact: true }).fill("fixture-cloud");
  const artifactPath = path.join(catalog, "foom-host.gz");
  await rm(artifactPath);
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(
    page.getByText("Remote host artifact unavailable in this local build", { exact: true }),
  ).toBeVisible();
  await capture("995-after-artifact");
  await writeFile(artifactPath, compressed);
  for (const [host, text, name] of [
    ["version-cloud", "Host version mismatch", "version"],
    ["invalid-cloud", "Invalid host reply", "reply"],
    ["provider-cloud", "Agent configuration unavailable", "provider"],
    ["configuration-cloud", "Agent configuration changed", "configuration"],
    ["cancelled-cloud", "Host check cancelled", "cancelled"],
  ]) {
    await page.getByLabel("SSH host", { exact: true }).fill(host);
    await page.getByRole("button", { name: "Test connection", exact: true }).click();
    await expect(page.getByText(text, { exact: true })).toBeVisible();
    await capture(`995-after-${name}`);
  }
  await page.getByLabel("SSH host", { exact: true }).fill("fixture-cloud");
  await page.getByLabel("Code folder", { exact: true }).fill("~/refused");
  await page.getByRole("button", { name: "Check folder", exact: true }).click();
  await expect(page.getByText("Code folder unavailable", { exact: true })).toBeVisible();
  await page.getByLabel("Code folder", { exact: true }).fill("~/unsafe");
  await page.getByRole("button", { name: "Check folder", exact: true }).click();
  await expect(
    page.getByText("Code folder ownership or permissions are unsafe", { exact: true }),
  ).toBeVisible();
  await capture("folder-failure");
  await page.getByLabel("Code folder", { exact: true }).fill("~/foom");
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(
    page.getByText("Connection ready · Code folder checked", { exact: true }),
  ).toBeVisible();
  await capture("add-tested");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const card = page.getByRole("region", { name: "fixture-cloud", exact: true });
  await expect(card.getByText("CPU cores", { exact: true })).toBeVisible();
  await expect(card.getByText("Not found", { exact: true })).toHaveCount(2);
  await expect(card.getByText("Unable to check", { exact: true }).first()).toBeVisible();
  await card.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(card.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  await capture("host-facts-agents");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(960, 960),
  );
  await assertHostColumns();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(1280, 960),
  );
  await assertAccessible(page);
  await page.getByRole("button", { name: "Add host", exact: true }).click();
  await page.getByLabel("SSH host", { exact: true }).fill("other-cloud");
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("region", { name: "other-cloud", exact: true })).toBeVisible();
  await navigation.getByRole("button", { name: "Repositories", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "Local", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clone here", exact: true })).toHaveCount(2);
  await expect(page.getByText("Not checked out", { exact: true })).toHaveCount(2);
  // Each management connection has its own fixture process; the selected reason
  // comes from a fixture file and never from raw remote output.
  for (const [reason, text] of [
    ["origin-auth", "Origin authentication failed"],
    ["origin-host-key", "Origin SSH host key is not trusted"],
    ["origin-unreachable", "Origin unreachable"],
    ["timed-out", "Git operation timed out"],
    ["checkout-invalid", "Checkout validation failed"],
  ]) {
    await writeFile(cloneReason, reason);
    await page.getByRole("button", { name: "Clone here", exact: true }).first().click();
    await expect(page.getByText(text, { exact: true })).toBeVisible();
    await expect(page.getByText("RAW GIT SECRET", { exact: true })).toHaveCount(0);
    await capture(`1004-${reason}`);
  }
  await capture("repository-hosts");
  await page.getByRole("button", { name: "Clone here", exact: true }).last().click();
  await expect(page.getByText("Clean", { exact: true })).toBeVisible();
  await assertAccessible(page);
  const recorded = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    recorded.some(
      ({ message }) =>
        message.operation === "clone" && message.origin === "git@forge.test:team/project.git",
    ),
  );
  assert.ok(
    recorded.every(({ message }) => !["kill", "stop", "open", "agent-open"].includes(message.type)),
  );
  await navigation.getByRole("button", { name: "Hosts", exact: true }).click();
  await page
    .getByRole("region", { name: "fixture-cloud", exact: true })
    .getByRole("button", { name: "Install git", exact: true })
    .click();
  await expect
    .poll(
      async () => (await readFile(recipeCalls, "utf8")).trim().split("\n").filter(Boolean).length,
    )
    .toBe(1);
  await expect(page.locator(".terminal-tile[data-kind='shell']")).toHaveCount(1);
  await expect(page.locator(".terminal-tile[data-kind='shell']")).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const id = (await window.desktop.workspace()).terminals[0]?.id;
        return id ? (await window.desktop.tail(id, 40)).join("\n") : "";
      }),
    )
    .toContain("FIXTURE_RECIPE_COMPLETE");
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Hosts", exact: true })
    .click();
  await page
    .getByRole("region", { name: "fixture-cloud", exact: true })
    .getByRole("button", { name: "Sign in gh", exact: true })
    .click();
  await expect
    .poll(
      async () => (await readFile(recipeCalls, "utf8")).trim().split("\n").filter(Boolean).length,
    )
    .toBe(2);
  await expect(page.locator(".terminal-tile[data-kind='shell']")).toBeVisible();
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
  await expect(page.getByRole("region", { name: "fixture-cloud", exact: true })).toBeVisible();
  await capture("host-recipes");
  await page
    .getByRole("region", { name: "fixture-cloud", exact: true })
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "fixture-cloud", exact: true })).toHaveCount(0);
  assert.equal(
    (await page.evaluate(() => window.desktop.setupState())).settings.registeredHosts.length,
    1,
  );
  await assert.rejects(page.evaluate(() => window.desktop.saveSetup({ registeredHosts: [] })));
  await expect(page.getByText("RAW SSH SECRET", { exact: true })).toHaveCount(0);
});
