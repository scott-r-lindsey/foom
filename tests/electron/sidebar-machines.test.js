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
const { boardPage, launchApp, removeAfterApps, assertAccessible } = require("./harness.js");

test("sidebar machines launch human shells and agents and keep remote worktrees under repositories", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "sidebar-machines-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const calls = path.join(root, "calls.jsonl");
  const offline = path.join(root, "offline");
  const agentChoice = path.join(root, "agents");
  const catalog = path.resolve("build/remote-hosts", `${process.platform}-${process.arch}`);
  const backups = new Map();
  for (const name of ["foom-host.gz", "manifest.json"]) {
    try {
      backups.set(name, await readFile(path.join(catalog, name)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  context.after(async () => {
    for (const name of ["foom-host.gz", "manifest.json"]) {
      const backup = backups.get(name);
      if (backup) await writeFile(path.join(catalog, name), backup);
      else await rm(path.join(catalog, name), { force: true });
    }
  });
  const bytes = Buffer.from("fixture daemon, never executed");
  const compressed = gzipSync(bytes);
  const hash = (data) => createHash("sha256").update(data).digest("hex");
  const manifest = {
    version: require("../../package.json").version,
    protocol: 3,
    source: gitSync(["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    platform: process.platform,
    arch: process.arch,
    size: bytes.length,
    sha256: hash(bytes),
    gzipSize: compressed.length,
    gzipSha256: hash(compressed),
  };
  await mkdir(catalog, { recursive: true });
  await writeFile(path.join(catalog, "foom-host.gz"), compressed);
  await writeFile(path.join(catalog, "manifest.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(bin, "ssh"),
    `#!${process.execPath}
const fs=require('node:fs');const assert=require('node:assert/strict');
const args=process.argv.slice(2);const host=args[args.indexOf('--')+1];
assert.ok(['fixture-cloud','offline-cloud'].includes(host));
for(const flag of ['BatchMode=yes','ClearAllForwardings=yes','ForwardAgent=no','ForwardX11=no'])assert.ok(args.includes(flag));
if(host==='offline-cloud'||fs.existsSync(${JSON.stringify(offline)}))process.exit(255);
if(args.at(-1)==='uname -s; uname -m'){process.stdout.write((process.platform==='darwin'?'Darwin':'Linux')+'\\n'+(process.arch==='x64'?'x86_64':process.platform==='darwin'?'arm64':'aarch64')+'\\n');process.exit(0);}
if(args.at(-1).includes('FOOM-LIBC-UNSUPPORTED')&&!args.at(-1).includes('FOOM-READY'))process.exit(0);
process.stdout.write('FOOM-READY\\n');
const {RemoteFrames,remoteResponseFrames}=require(${JSON.stringify(path.resolve("build/shared/remote-host-protocol.js"))});
const frames=new RemoteFrames();const send=value=>{for(const frame of remoteResponseFrames(value))process.stdout.write(frame)};
let output='FIXTURE_MACHINE_READY\\r\\n';
process.stdin.on('data',bytes=>frames.push(bytes,message=>{
 fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({host,message})+'\\n');
 if(message.type==='hello'){send({type:'hello',build:${JSON.stringify(manifest.sha256)},humanMachines:2});return;}
 if(message.type==='inventory'){send({type:'inventory-result',own:[],foreign:[]});return;}
 if(message.type==='open'){
  assert.equal(message.human,true);assert.equal(message.agent,undefined);
  assert.equal(message.machine.codeFolder,'/remote/code');
  if(message.machine.agent){assert.ok(['claude','codex'].includes(message.machine.agent));assert.deepEqual(message.machine.defaults,[]);}
  output='FIXTURE_'+(message.machine.agent||'shell')+' /remote/code\\r\\n';
  send({type:'open-result',id:message.id,request:message.request,state:'live'});return;
 }
 if('id' in message){
  if(message.type==='attach')send({type:'data',id:message.id,view:message.view,token:'fixture-machine',data:output});
  send({type:'result',id:message.id,request:message.request,lines:output.split('\\r\\n'),cols:80,rows:24,title:'Machine'});return;
 }
 assert.equal(message.type,'manage');
 const choice=fs.existsSync(${JSON.stringify(agentChoice)})?fs.readFileSync(${JSON.stringify(agentChoice)},'utf8'):'';
 const facts={codeFolder:'/remote/code',version:${JSON.stringify(manifest.version)},sessions:0,cores:4,load:[0,0,0],memoryTotal:1000,memoryAvailable:900,agents:[{id:'claude',state:choice==='none'?'missing':'ready'},{id:'codex',state:choice==='multiple'?'ready':'missing'}]};
 const result={ok:true,facts};
 if(['repository','clone'].includes(message.operation))result.checkout={path:'/remote/code/'+message.directory,state:'clean'};
 if(message.operation==='inspect-worktree')result.worktree={path:message.path,branch:'remote-work',identity:message.identity,changes:''};
 if(message.operation==='list-worktrees')result.inventory={own:[{repository:'/remote/code/repository-'+require('node:crypto').createHash('sha256').update('git@forge.test:team/project.git').digest('hex').slice(0,24),path:'/remote/code/.foom-worktree-fixture',branch:'remote-work',identity:'a'.repeat(64),origin:'git@forge.test:team/project.git'}],other:0};
 send({type:'managed',result});
}));`,
    { mode: 0o700 },
  );
  const app = await launchApp(context, { fixture: "repository", env: { PATH: bin } });
  const page = await boardPage(app);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(1280, 900),
  );
  const repository = await page.evaluate(
    async () => (await window.desktop.workspace()).repositories[0].path,
  );
  gitSync(["remote", "add", "origin", "git@forge.test:team/project.git"], { cwd: repository });
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
      await page.screenshot({
        path: evidencePath(`1024/${name}-${mode}.png`),
        animations: "disabled",
      });
    }
  };
  await expect(page.getByRole("group", { name: "Machines" })).toHaveCount(0);
  await capture("single-machine");
  await page.evaluate(() =>
    window.desktop.hosts({ action: "add", host: "fixture-cloud", codeFolder: "/remote/code" }),
  );
  await page.evaluate(() =>
    window.desktop.hosts({ action: "add", host: "offline-cloud", codeFolder: "/remote/code" }),
  );
  await page.evaluate(() =>
    window.desktop.hosts({ action: "rename", host: "fixture-cloud", nickname: "Builder" }),
  );
  await expect(
    page.getByRole("button", { name: "Actions for Builder", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "Machines" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Actions for offline-cloud", exact: true }),
  ).toBeDisabled();
  assert.deepEqual(
    await page.locator(".machine-section > .machine-row > .tree-name").allTextContents(),
    ["localhost", "Builder", "offline-cloud"],
  );
  const statusTypography = await page
    .locator(".machine-status")
    .first()
    .evaluate((element) => ({
      family: getComputedStyle(element).fontFamily,
      size: getComputedStyle(element).fontSize,
      rowFamily: getComputedStyle(element.parentElement.querySelector(".tree-name")).fontFamily,
    }));
  assert.equal(statusTypography.family, statusTypography.rowFamily);
  assert.equal(statusTypography.size, "11px");
  await capture("machines");
  await page.getByRole("button", { name: "Actions for Builder", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "New Claude Code", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "New Codex", exact: true })).toHaveCount(0);
  await capture("machine-menu");
  await page.getByRole("menuitem", { name: "New shell", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.desktop.workspace()).terminals.filter(
            (row) => row.machine && row.agent === "shell",
          ).length,
      ),
    )
    .toBe(1);
  await expect(page.getByRole("menu", { name: "Actions for Builder", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Actions for Builder", exact: true }).click();
  await page.getByRole("menuitem", { name: "New Claude Code", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.desktop.workspace()).terminals.filter(
            (row) => row.machine && row.agent === "claude",
          ).length,
      ),
    )
    .toBe(1);
  const loose = await page.evaluate(async () =>
    (await window.desktop.workspace()).terminals.filter((row) => row.machine),
  );
  assert.ok(
    loose.every(
      (row) =>
        row.placement.kind === "remote" &&
        row.placement.host === "fixture-cloud" &&
        !row.orchestration,
    ),
  );
  await expect(
    page
      .locator(".machine-section")
      .filter({ has: page.getByRole("button", { name: "Actions for Builder", exact: true }) })
      .locator(".board-row"),
  ).toHaveCount(2);
  await capture("loose-sessions");
  await page.getByRole("button", { name: "Actions for shell-fixture", exact: true }).click();
  await page.getByRole("menuitem", { name: "New worktree", exact: true }).hover();
  await expect(page.getByRole("menuitem", { name: "localhost", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Builder", exact: true })).toBeVisible();
  await capture("machine-choice");
  await page.getByRole("menuitem", { name: "Builder", exact: true }).click();
  const branch = page.getByLabel("Branch for the new worktree");
  await expect(branch).toBeFocused();
  await branch.fill("prepare-host");
  await capture("remote-worktree-field");
  await branch.press("Escape");
  await page.getByRole("menuitem", { name: "New agent", exact: true }).hover();
  await capture("agent-machine-choice");
  await page.getByRole("menuitem", { name: "Builder", exact: true }).hover();
  await expect(page.getByRole("menuitem", { name: "Claude Code", exact: true })).toBeVisible();
  await capture("agent-choice");
  await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.desktop.workspace()).terminals.filter(
            (row) => row.branch === "Main checkout" && row.placement?.kind === "remote",
          ).length,
      ),
    )
    .toBe(1);
  await capture("repository-agent");
  const remoteWorktree = page.locator(".worktree-row").filter({ hasText: "remote-work" });
  await expect(remoteWorktree.getByLabel("Host: Builder")).toBeVisible();
  await capture("worktree-chip");
  await remoteWorktree.locator(".row-actions").click();
  await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
  await expect(
    page
      .locator(".terminal-tile")
      .filter({ has: page.locator(".tile-location").filter({ hasText: "remote-work" }) })
      .getByLabel("Host: Builder"),
  ).toBeVisible();
  await capture("worktree-tile-chip");
  // Prepare is available only for pinned, checked-out repositories.
  await page.getByRole("button", { name: "Actions for shell-fixture", exact: true }).click();
  await page.getByRole("menuitem", { name: "Pin to top", exact: true }).click();
  await expect(page.getByLabel("Pinned", { exact: true })).toBeVisible();
  const hostMenu = page.getByRole("button", { name: "Actions for Builder", exact: true });
  const prepare = page.getByRole("menuitem", { name: "Prepare for shell-fixture", exact: true });
  await hostMenu.click();
  await page.getByRole("menuitem", { name: "shell-fixture", exact: true }).hover();
  await expect(prepare).toBeVisible();
  assert.equal(await prepare.getAttribute("aria-haspopup"), null);
  await capture("prepare-single");
  await prepare.click();
  const shared = () =>
    page.getByRole("menuitem", { name: "Click again for multiple agents here", exact: true });
  await expect(shared()).toBeVisible();
  // The existing shared-checkout warning requires an interval before its second click.
  await page.waitForTimeout(310);
  await shared().click();
  const preparedRows = async () =>
    page.evaluate(async () =>
      (await window.desktop.workspace()).terminals.filter(
        (row) => row.branch === "Main checkout" && row.placement?.kind === "remote",
      ),
    );
  await expect.poll(async () => (await preparedRows()).length).toBe(2);
  const prepared = (await preparedRows()).at(-1);
  assert.equal(prepared.agent, "claude");
  assert.equal(prepared.placement.host, "fixture-cloud");
  assert.equal(prepared.orchestration, undefined);
  const preparedTile = () =>
    page.evaluate((id) => {
      const layout = JSON.parse(localStorage.getItem(`foom.tiles.v1.${window.desktop.windows.id}`));
      const locate = (node) =>
        node.kind === "split"
          ? locate(node.first) || locate(node.second)
          : node.content?.session === id
            ? node.id
            : null;
      return locate(layout.tree);
    }, prepared.id);
  await expect.poll(preparedTile).toBeTruthy();
  await expect(page.locator(`[data-tile="${await preparedTile()}"]`)).toBeVisible();
  await capture("prepare-tile");
  const refreshAgents = async (choice) => {
    await writeFile(`${agentChoice}.next`, choice);
    await rename(`${agentChoice}.next`, agentChoice);
    const checked = await page.evaluate(() =>
      window.desktop.hosts({
        action: "preflight",
        host: "fixture-cloud",
        codeFolder: "/remote/code",
      }),
    );
    // The host check and the board's inventory projection settle independently.
    const inventory = await page.evaluate(() => window.desktop.sidebarInventory());
    const machine = inventory.machines.find((entry) => entry.host === "fixture-cloud");
    const cached = await page.evaluate(() => window.desktop.hosts({ action: "progress" }));
    const observations = (result) =>
      result?.ok ? result.facts.agents.map(({ id, state }) => ({ id, state })) : result;
    context.diagnostic(
      JSON.stringify({
        choice,
        checked: observations(checked.preflight?.result),
        cached: observations(cached.hosts.find((entry) => entry.host === "fixture-cloud")?.result),
        sidebarAgents: machine?.agents.map((agent) => agent.id),
      }),
    );
    assert.ok(machine?.available);
    assert.deepEqual(
      machine.agents.map((agent) => agent.id),
      choice === "multiple" ? ["claude", "codex"] : [],
    );
    if (choice === "none")
      assert.ok(checked.preflight.result.facts.agents.every((agent) => agent.state !== "ready"));
  };
  await refreshAgents("multiple");
  await hostMenu.click();
  await expect(page.getByRole("menuitem", { name: "New Codex", exact: true })).toBeVisible();
  const hostLabels = await page
    .getByRole("menu", { name: "Actions for Builder", exact: true })
    .getByRole("menuitem")
    .allTextContents();
  await page.getByRole("menuitem", { name: "shell-fixture", exact: true }).hover();
  await prepare.hover();
  const prepareChoices = page.getByRole("menu", { name: "Prepare for shell-fixture", exact: true });
  await expect(prepareChoices).toBeVisible();
  assert.deepEqual(
    await prepareChoices.getByRole("menuitem").allTextContents(),
    hostLabels.slice(1, 3).map((label) => label.replace(/^New /, "")),
  );
  await capture("prepare-agents");
  await prepareChoices.getByRole("menuitem", { name: "Codex", exact: true }).click();
  await expect(shared()).toBeVisible();
  await page.waitForTimeout(310);
  await shared().click();
  await expect.poll(async () => (await preparedRows()).length).toBe(3);
  assert.equal((await preparedRows()).at(-1).agent, "codex");
  await refreshAgents("none");
  await hostMenu.click();
  const emptyAgentMenu = page.getByRole("menu", { name: "Actions for Builder", exact: true });
  context.diagnostic(
    JSON.stringify({
      menus: await page.getByRole("menu").evaluateAll((elements) =>
        elements.map((element) => ({
          name: element.getAttribute("aria-label"),
          items: Array.from(element.querySelectorAll('[role="menuitem"]')).map(
            (item) => item.textContent,
          ),
        })),
      ),
    }),
  );
  try {
    await expect(emptyAgentMenu).toBeVisible();
    await expect(
      emptyAgentMenu.getByRole("menuitem", { name: "New Claude Code", exact: true }),
    ).toHaveCount(0);
    await expect(
      emptyAgentMenu.getByRole("menuitem", { name: "New Codex", exact: true }),
    ).toHaveCount(0);
    await expect(
      emptyAgentMenu.getByRole("menuitem", { name: "shell-fixture", exact: true }),
    ).toHaveCount(0);
  } catch (error) {
    await page.screenshot({
      path: evidencePath(`1024/prepare-zero-failure-${process.platform}.png`),
      animations: "disabled",
    });
    throw error;
  }
  await capture("prepare-no-agents");
  await page.keyboard.press("Escape");
  await writeFile(offline, "offline");
  await page.evaluate(() =>
    window.desktop.hosts({
      action: "preflight",
      host: "fixture-cloud",
      codeFolder: "/remote/code",
    }),
  );
  await expect(remoteWorktree.getByLabel("Builder · Unavailable")).toBeVisible();
  await capture("unavailable-chip");
  await assertAccessible(page);
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await capture("compact-unavailable");
  const observed = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const preparations = observed.filter(
    (call) => call.message.type === "open" && call.message.machine?.prompt,
  );
  assert.deepEqual(
    preparations.map((call) => call.message.machine.agent),
    ["claude", "codex"],
  );
  const { repositoryPreparationPrompt } = require("../../build/shared/repository-preparation.js");
  for (const { host, message } of preparations) {
    assert.equal(host, "fixture-cloud");
    assert.equal(message.human, true);
    assert.equal(message.agent, undefined);
    assert.equal(message.machine.prompt, repositoryPreparationPrompt("shell-fixture"));
    assert.ok(message.machine.repository.directory.startsWith("repository-"));
    assert.equal(message.machine.repository.origin, "git@forge.test:team/project.git");
  }
  assert.ok(
    observed.some(
      (call) => call.message.type === "open" && call.message.machine.agent === "claude",
    ),
  );
});
