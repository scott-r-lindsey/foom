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

async function sidebarMachines(context, startupOnly = false, firstRemoteOnly = false) {
  const root = await mkdtemp(path.join(tmpdir(), "sidebar-machines-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const calls = path.join(root, "calls.jsonl");
  const offline = path.join(root, "offline");
  const agentChoice = path.join(root, "agents");
  const launchGate = path.join(root, "launch-gate");
  const blockedSsh = path.join(root, "blocked-ssh");
  const exitedSsh = path.join(root, "exited-ssh");
  const discoveryGate = path.join(root, "discovery-gate");
  const discoveryEntered = path.join(root, "discovery-entered");
  if (startupOnly)
    await writeFile(
      path.join(bin, "claude"),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
let entered = false;
function run() {
 if (args.includes('--version')) process.stdout.write('2.1.285 (Claude Code)\\n');
 else if (args.includes('--help')) process.stdout.write('--settings\\n');
 else { process.stdout.write('LOCAL_STARTUP_READY\\r\\n'); process.stdin.resume(); return; }
 process.exit(0);
}
function wait() { if (args.some(arg => arg === '--version' || arg === '--help') && fs.existsSync(${JSON.stringify(discoveryGate)})) { if (!entered) { fs.writeFileSync(${JSON.stringify(discoveryEntered)}, 'blocked'); entered = true; } setTimeout(wait, 20); } else run(); }
wait();`,
      { mode: 0o700 },
    );
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
process.on('SIGTERM', () => process.exit(0));
process.on('exit', () => fs.appendFileSync(${JSON.stringify(exitedSsh)}, String(process.pid)+'\\n'));
let held = false;
assert.ok(['fixture-cloud','offline-cloud'].includes(host));
for(const flag of ['BatchMode=yes','ClearAllForwardings=yes','ForwardAgent=no','ForwardX11=no'])assert.ok(args.includes(flag));
function run() {
if(host==='offline-cloud'||fs.existsSync(${JSON.stringify(offline)}))process.exit(255);
if(args.at(-1)==='uname -s; uname -m'){process.stdout.write((process.platform==='darwin'?'Darwin':'Linux')+'\\n'+(process.arch==='x64'?'x86_64':process.platform==='darwin'?'arm64':'aarch64')+'\\n');process.exit(0);}
if(args.at(-1).includes('FOOM-LIBC-UNSUPPORTED')&&!args.at(-1).includes('FOOM-READY'))process.exit(0);
process.stdout.write('FOOM-READY\\n');
const {RemoteFrames,remoteResponseFrames}=require(${JSON.stringify(path.resolve("build/shared/remote-host-protocol.js"))});
const frames=new RemoteFrames();const send=value=>{for(const frame of remoteResponseFrames(value))process.stdout.write(frame)};
let output='FIXTURE_MACHINE_READY\\r\\n';
process.stdin.on('data',bytes=>frames.push(bytes,message=>{
 fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({host,message})+'\\n');
 if(message.type==='hello'){send({type:'hello',build:${JSON.stringify(manifest.sha256)},humanMachines:1,machineHome:'/remote/home'});return;}
 if(message.type==='inventory'){send({type:'inventory-result',own:[],foreign:[]});return;}
 if(message.type==='open'){
  assert.equal(message.human,true);assert.equal(message.agent,undefined);
  assert.equal(message.machine.codeFolder,'/remote/code');
  if(message.machine.agent){assert.ok(['claude','codex'].includes(message.machine.agent));assert.deepEqual(message.machine.defaults,[]);}
  const cwd=message.checkout?.path||(message.machine.repository?'/remote/code/'+message.machine.repository.directory:'/remote/home');
  if(!message.checkout&&!message.machine.repository){assert.equal(message.context.repository,cwd);assert.equal(message.context.worktree,cwd);}
  output='FIXTURE_'+(message.machine.agent||'shell')+' '+cwd+'\\r\\n';
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
}));
}
function wait() { if (args.at(-1).includes('FOOM-READY') && fs.existsSync(${JSON.stringify(launchGate)})) { if (!held) { fs.appendFileSync(${JSON.stringify(blockedSsh)}, String(process.pid)+'\\n'); held = true; } setTimeout(wait, 20); } else run(); }
wait();`,
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
      if (name === "remote-worktree-field" && process.env.FOOM_POLISH_SCREENSHOTS === "1") {
        await page.locator(".panel-header").screenshot({
          path: evidencePath(`1045/panel-chip-${mode}.png`),
          animations: "disabled",
        });
      }
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
  if (startupOnly) {
    const launch = async () => {
      await page.getByRole("button", { name: "Actions for Builder", exact: true }).click();
      await page.getByRole("menuitem", { name: "New shell", exact: true }).click();
    };
    await writeFile(launchGate, "hold");
    await launch();
    const startup = page.locator(".tile-startup").filter({ hasText: "Starting on Builder…" });
    await expect(startup).toBeVisible();
    await expect(page.getByRole("menu", { name: "Actions for Builder", exact: true })).toHaveCount(
      0,
    );
    const tileId = await startup.locator("..").getAttribute("data-tile");
    assert.ok(tileId);
    const tile = page.locator(`[data-tile="${tileId}"]`);
    for (const mode of ["light", "dark"]) {
      await page.evaluate(
        (mode) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${mode}` }),
        mode,
      );
      await expect(page.locator("html")).toHaveCSS("color-scheme", mode);
      await tile.screenshot({
        path: evidencePath(`1044/startup-${mode}.png`),
        animations: "disabled",
      });
    }
    await launch();
    await expect(startup).toHaveCount(1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(startup.locator(".tile-startup-orbit")).toHaveCSS("animation-name", "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await rm(launchGate);
    await expect(tile.locator(".xterm")).toContainText("FIXTURE_shell /remote/home");
    await expect(startup).toHaveCount(0);
    assert.equal(await tile.getAttribute("data-tile"), tileId);
    const opened = () =>
      readFile(calls, "utf8").then((text) =>
        text
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter(({ message }) => message.type === "open"),
      );
    assert.equal((await opened()).length, 1);

    const lines = async (file) => {
      try {
        return (await readFile(file, "utf8")).trim().split("\n");
      } catch {
        return [];
      }
    };
    const previousBlocked = new Set(await lines(blockedSsh));
    await writeFile(launchGate, "hold");
    await launch();
    await expect(startup).toBeVisible();
    await expect
      .poll(async () => (await lines(blockedSsh)).filter((pid) => !previousBlocked.has(pid)).length)
      .toBeGreaterThan(0);
    const cancelled = startup.locator("..");
    await cancelled.getByRole("button", { name: "Close", exact: true }).click();
    await expect(startup).toHaveCount(0);
    await expect
      .poll(async () => {
        const exited = new Set(await lines(exitedSsh));
        return (await lines(blockedSsh)).some(
          (pid) => !previousBlocked.has(pid) && exited.has(pid),
        );
      })
      .toBe(true);
    await rm(launchGate);
    assert.equal(
      (await opened()).length,
      1,
      "Cancellation must not send a session-open after the blocked SSH stage",
    );

    // Invalidate discovery explicitly while retaining the already-rendered launcher.
    await page.evaluate(() => window.desktop.scanAgents(false));
    await writeFile(discoveryGate, "hold");
    await page.evaluate(() => {
      window.startupFixtureScan = window.desktop.scanAgents(true);
    });
    await expect
      .poll(async () => {
        try {
          return await readFile(discoveryEntered, "utf8");
        } catch {
          return "";
        }
      })
      .toBe("blocked");
    await page.getByRole("button", { name: "Actions for Main checkout", exact: true }).click();
    await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
    const localStartup = page.locator('.tile-startup[data-remote="false"]');
    await expect(localStartup).toBeVisible();
    await expect(page.locator(".sidebar-panel")).toHaveCount(0);
    await rm(discoveryGate);
    await expect(
      page.locator(".terminal-tile .xterm").filter({ hasText: "LOCAL_STARTUP_READY" }),
    ).toBeVisible();
    await expect(localStartup).toHaveCount(0);
    if (firstRemoteOnly) {
      // No remote session exists when this repository's first remote agent is requested.
      await page.evaluate(async () => {
        for (const row of (await window.desktop.workspace()).terminals)
          if (row.placement?.kind === "remote") await window.desktop.kill(row.id);
      });
      await expect
        .poll(() =>
          page.evaluate(
            async () =>
              (await window.desktop.workspace()).terminals.filter(
                (row) => row.placement?.kind === "remote",
              ).length,
          ),
        )
        .toBe(0);
      await page.getByRole("button", { name: "Actions for shell-fixture", exact: true }).click();
      await page.getByRole("menuitem", { name: "New agent", exact: true }).hover();
      await page.getByRole("menuitem", { name: "Builder", exact: true }).hover();
      await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
      await expect(page.locator(".sidebar-panel")).toHaveCount(0);
      await expect(
        page.getByRole("menuitem", { name: "Click again for multiple agents here", exact: true }),
      ).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(
            async () =>
              (await window.desktop.workspace()).terminals.filter(
                (row) =>
                  row.agent === "claude" &&
                  row.branch === "Main checkout" &&
                  row.placement?.host === "fixture-cloud",
              ).length,
          ),
        )
        .toBe(1);
      await expect(page.locator('.tile-startup[data-failed="true"]')).toHaveCount(0);
      return;
    }
    const requestShared = async () => {
      const actions = page.getByRole("button", { name: "Actions for Main checkout", exact: true });
      await actions.press("Escape");
      await actions.click();
      await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
      const armed = page.getByRole("menuitem", {
        name: "Click again for multiple agents here",
        exact: true,
      });
      await expect(armed).toBeVisible();
      await expect(page.locator(".tile-startup")).toHaveCount(0);
      return armed;
    };
    const spacesBeforeWarning = await page.locator(".terminal-tile").count();
    for (const abandon of ["pointer", "blur", "expiry"]) {
      const warning = await requestShared();
      if (abandon === "pointer") await page.mouse.move(0, 0);
      else if (abandon === "blur")
        await page.getByRole("button", { name: "Actions for Main checkout", exact: true }).focus();
      // Main's existing three-second expiry is the behavior under test.
      await expect(warning).toHaveCount(0);
      await page.evaluate(async () => {
        await window.desktop.sidebarInventory();
        await window.desktop.workspace();
      });
      await expect(page.locator(".tile-startup")).toHaveCount(0);
      await expect(page.locator(".terminal-tile")).toHaveCount(spacesBeforeWarning);
      await expect(page.getByRole("dialog", { name: "Action failed", exact: true })).toHaveCount(0);
    }
    const armed = await requestShared();
    await expect(page.locator(".sidebar-panel")).toHaveCount(1);
    // The sharing capability deliberately rejects a second click before 300 ms.
    await page.waitForTimeout(310);
    await armed.click();
    await expect(page.locator(".sidebar-panel")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.desktop.workspace()).terminals.filter(
              (row) => row.agent === "claude" && row.placement?.kind !== "remote",
            ).length,
        ),
      )
      .toBe(2);
    return;
  }
  await page.getByRole("button", { name: "Actions for Builder", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "New Claude Code", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "New Codex", exact: true })).toHaveCount(0);
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
        row.repository === "/remote/home" &&
        row.worktree === "/remote/home" &&
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
  // Leave room for two occupied tiles so focus can move off the chip's tile.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(1800, 900),
  );
  await remoteWorktree.locator(".row-actions").click();
  await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
  await expect(
    page
      .locator(".terminal-tile")
      .filter({ has: page.locator(".tile-location").filter({ hasText: "remote-work" }) })
      .getByLabel("Host: Builder"),
  ).toBeVisible();
  await capture("worktree-tile-chip");
  const remoteTile = page.locator(".terminal-tile").filter({
    has: page.locator(".tile-location").filter({ hasText: "remote-work" }),
  });
  const chipStates = async (availability) => {
    await expect(remoteTile.locator(".host-chip svg")).toHaveCount(1);
    await expect(remoteWorktree.locator(".host-chip svg")).toHaveCount(0);
    for (const mode of ["light", "dark"]) {
      await page.evaluate(
        (mode) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${mode}` }),
        mode,
      );
      await expect(page.locator("html")).toHaveCSS("color-scheme", mode);
      for (const focused of [true, false]) {
        const target = focused
          ? remoteTile
          : page
              .locator('.terminal-tile[data-empty="false"]')
              .filter({ hasNot: page.locator(".tile-location").filter({ hasText: "remote-work" }) })
              .first();
        await target.locator(".tile-number").focus();
        await expect(remoteTile).toHaveAttribute("data-focused", String(focused));
        const chip = remoteTile.locator(".host-chip");
        assert.notEqual(
          await chip.evaluate((node) => getComputedStyle(node).backgroundColor),
          "rgba(0, 0, 0, 0)",
        );
        if (process.env.FOOM_POLISH_SCREENSHOTS === "1") {
          await remoteTile.locator(".tile-title").screenshot({
            path: evidencePath(
              `1045/tile-${availability}-${focused ? "focused" : "unfocused"}-${mode}.png`,
            ),
            animations: "disabled",
          });
        }
      }
      const width = page.getByRole("separator", { name: "Sidebar width", exact: true });
      const minimumWidth = await width.getAttribute("aria-valuemin");
      assert.ok(minimumWidth);
      await width.press("Home");
      await expect(width).toHaveAttribute("aria-valuenow", minimumWidth);
      // Width metadata commits before the sidebar's resize transition settles.
      await expect
        .poll(async () => {
          const chipBox = await remoteWorktree.locator(".host-chip").boundingBox();
          const rowBox = await remoteWorktree.boundingBox();
          if (!chipBox || !rowBox) return Infinity;
          return Math.max(
            rowBox.x - chipBox.x,
            chipBox.x + chipBox.width - rowBox.x - rowBox.width,
          );
        })
        .toBeLessThanOrEqual(1);
      if (process.env.FOOM_POLISH_SCREENSHOTS === "1") {
        await remoteWorktree.screenshot({
          path: evidencePath(`1045/sidebar-narrow-${availability}-${mode}.png`),
          animations: "disabled",
        });
      }
      await width.dblclick();
      await expect(width).toHaveAttribute("aria-valuenow", "300");
    }
  };
  await chipStates("available");
  const hostMenu = page.getByRole("button", { name: "Actions for Builder", exact: true });
  const refreshAgents = async (choice) => {
    // Await the preceding launch command's renderer refresh before changing host facts.
    await expect(page.locator(".sidebar-panel")).toHaveCount(0);
    const menu = page.getByRole("menu", { name: "Actions for Builder", exact: true });
    await expect(menu).toHaveCount(0);
    await expect(hostMenu).toHaveAttribute("aria-expanded", "false");
    await writeFile(`${agentChoice}.next`, choice);
    await rename(`${agentChoice}.next`, agentChoice);
    const checked = await page.evaluate(() =>
      window.desktop.hosts({
        action: "preflight",
        host: "fixture-cloud",
        codeFolder: "/remote/code",
      }),
    );
    // The bridge and the rendered menu settle independently.
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await window.desktop.sidebarInventory()).machines
            .find((entry) => entry.host === "fixture-cloud")
            ?.agents.map((agent) => agent.id),
        ),
      )
      .toEqual(choice === "multiple" ? ["claude", "codex"] : []);
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
    await hostMenu.click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveText(
      choice === "multiple" ? ["New shell", "New Claude Code", "New Codex"] : ["New shell"],
    );
  };
  await refreshAgents("multiple");
  await expect(page.getByRole("menuitem", { name: "New Codex", exact: true })).toBeVisible();
  await capture("machine-menu");
  await page.keyboard.press("Escape");
  await refreshAgents("none");
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
  await chipStates("unavailable");
  await assertAccessible(page);
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await capture("compact-unavailable");
  const observed = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    observed.some(
      (call) => call.message.type === "open" && call.message.machine.agent === "claude",
    ),
  );
}

test(
  "sidebar machines launch human shells and agents and keep remote worktrees under repositories",
  {
    skip: process.platform === "win32",
    timeout: deadline(60000),
  },
  (context) => sidebarMachines(context),
);

test(
  "launch startup dismisses menus and reserves tiles during slow SSH and agent discovery",
  {
    skip: process.platform === "win32",
    timeout: deadline(60000),
  },
  (context) => sidebarMachines(context, true),
);

test("first remote repository launch ignores a local main-checkout agent in the real menu", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  await sidebarMachines(context, true, true);
});
