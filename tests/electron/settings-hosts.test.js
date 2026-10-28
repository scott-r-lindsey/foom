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
    protocol: 2,
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
assert.ok(['fixture-cloud','other-cloud','offline-cloud'].includes(host));
if (host === 'offline-cloud') { process.stderr.write('RAW SSH SECRET'); process.exit(1); }
if (args.at(-1) === 'uname -s; uname -m') { process.stdout.write(${JSON.stringify(`${platform === "darwin" ? "Darwin" : "Linux"}\n${process.arch === "x64" ? "x86_64" : platform === "darwin" ? "arm64" : "aarch64"}\n`)}); process.exit(0); }
process.stdout.write('FOOM-READY\\n');
let input=Buffer.alloc(0);
function send(message) { const data=Buffer.from(JSON.stringify({version:2,message})); const head=Buffer.alloc(4); head.writeUInt32BE(data.length); process.stdout.write(Buffer.concat([head,data])); }
process.stdin.on('data', bytes => {
 input=Buffer.concat([input,bytes]);
 while(input.length>=4 && input.length>=4+input.readUInt32BE(0)) {
  const n=input.readUInt32BE(0); const {message}=JSON.parse(input.subarray(4,4+n)); input=input.subarray(4+n);
  assert.equal('id' in message,false); appendFileSync(${JSON.stringify(calls)},JSON.stringify({host,message})+'\\n');
  if(message.type==='hello') { send({type:'hello',build:${JSON.stringify(manifest.sha256)}}); continue; }
  assert.equal(message.type,'manage');
  let result;
  if(message.codeFolder==='~/unsafe') result={ok:false,reason:'unsafe-folder'};
  else if(message.codeFolder==='~/refused') result={ok:false,reason:'folder-refused'};
  else if(message.operation==='clone' && host==='fixture-cloud') result={ok:false,reason:'clone-failed'};
  else {
   const folder=message.codeFolder.startsWith('~/')?'/remote/account/'+message.codeFolder.slice(2):message.codeFolder;
   result={ok:true,facts:{codeFolder:folder,version:${JSON.stringify(manifest.version)},sessions:2,cores:8,load:[0.42,0.31,0.25],memoryTotal:17179869184,memoryAvailable:11811160064,agents:[{id:'claude',state:'ready'},{id:'codex',state:'missing'},{id:'agy',state:'unable'}]}};
   if(message.operation==='repository' || message.operation==='clone') result.checkout={path:folder+'/'+message.directory,state:message.operation==='clone'?'clean':'absent'};
  }
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
  const capture = async (name) => {
    for (const mode of ["light", "dark"]) {
      await page.evaluate((colorMode) => window.desktop.saveSetup({ colorMode }), mode);
      await expect
        .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
        .toBe(mode === "dark");
      await page.screenshot({ path: evidencePath(`screenshots-757/${name}-${mode}.png`) });
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
  assert.equal(
    (await page.evaluate(() => window.desktop.setupState())).settings.registeredHosts,
    undefined,
  );
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
  await expect(card.getByText("Not found", { exact: true })).toBeVisible();
  await expect(card.getByText("Unable to check", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(card.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  await capture("host-facts-agents");
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
  await page.getByRole("button", { name: "Clone here", exact: true }).first().click();
  await expect(page.getByText("Could not clone from origin", { exact: true })).toBeVisible();
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
