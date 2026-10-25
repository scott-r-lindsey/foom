const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtemp, mkdir, writeFile, chmod, readFile, access } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { gitSync } = require("../helpers/git.js");
const { deadline, expect } = require("./test-policy.js");
const { launchApp, boardPage, removeAfterApps } = require("./harness.js");

test("Pi fixed per-launch extension observes lifecycle, filters role tools and removes its private files", {
  timeout: deadline(60000),
  skip: process.platform === "win32" && "The fake Pi is a POSIX executable",
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-pi-extension-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  const record = path.join(root, "record.json");
  await Promise.all([mkdir(bin), mkdir(repo), mkdir(home)]);
  gitSync(["init", "-q", "-b", "main"], { cwd: repo });
  gitSync(
    [
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ],
    { cwd: repo },
  );
  const cli = path.join(bin, "pi");
  await writeFile(
    cli,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('1.4.0');
else if (args[0] === '--help') console.log('--session --session-id --extension');
else (async () => {
  const handlers = new Map();
  let server;
  let exposure;
  const extension = args[args.indexOf('--extension') + 1];
  const ctx = {sessionManager: {getSessionId: () => args[args.indexOf('--session-id') + 1]}, isIdle: () => false};
  const emit = async (name, event = {}) => { for (const handler of handlers.get(name) || []) await handler(event, ctx); };
  const module = await import(require('node:url').pathToFileURL(extension).href);
  module.default({
    on(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); },
    registerMcpServer(name, config) { server = config; exposure = Object.keys(config.toolExposure); },
    unregisterMcpServer() { server = undefined; },
  });
  await emit('session_start');
  if (!server) throw new Error('MCP registration missing');
  let session;
  async function rpc(method, params, id) {
    const response = await fetch(server.url, {method:'POST', headers: {...server.headers, 'Content-Type':'application/json', Accept:'application/json, text/event-stream', ...(session ? {'Mcp-Session-Id':session} : {})}, body: JSON.stringify({jsonrpc:'2.0', ...(id === undefined ? {} : {id}), method, params})});
    session = response.headers.get('mcp-session-id') || session;
    return response.status === 202 ? {} : response.json();
  }
  await rpc('initialize', {protocolVersion:'2025-03-26', capabilities:{}, clientInfo:{name:'fake-pi', version:'1'}}, 1);
  await rpc('notifications/initialized', {});
  const listed = await rpc('tools/list', {}, 2);
  const denied = await rpc('tools/call', {name:'launch', arguments:{}}, 3);
  require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({extension, exposure, listed:listed.result.tools.map(tool => tool.name), denied:denied.result.isError}), {mode:0o600});
  await emit('agent_start');
  await emit('turn_start');
  await emit('ui_prompt_start', {title:'private prompt text must not be forwarded'});
  console.log('PI_FIXTURE_READY');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', () => { void (async () => {
    await emit('ui_prompt_end');
    await emit('turn_end');
    await emit('agent_before_settle', {outcome:'completed'});
    console.log('PI_FIXTURE_COMPLETE');
    await emit('agent_settled', {aborted:false});
  })(); });
})().catch(() => { console.error('PI_FIXTURE_FAILED'); process.exit(1); });
`,
  );
  await chmod(cli, 0o755);
  const app = await launchApp(context, { fixture: "agent", env: { HOME: home, PATH: bin } });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, repo);
  const repository = await page.evaluate(() => window.desktop.addRepository());
  const launched = await page.evaluate(async (repository) => {
    window.piExecutions = [];
    window.desktop.onExecution((event) => window.piExecutions.push(event));
    const scan = await window.desktop.scanAgents(true);
    const pi = scan.agents.find((agent) => agent.id === "pi");
    if (!pi?.hooks || !pi.mcp) throw new Error("Fixture Pi capability missing");
    return window.desktop.launchAgent({
      agent: "pi",
      repository,
      worktree: repository,
      cols: 80,
      rows: 24,
    });
  }, repository.path);
  assert.equal(launched.attention, "hooks");
  await expect
    .poll(() => page.evaluate((id) => window.desktop.tail(id, 10), launched.id))
    .toContain("PI_FIXTURE_READY");
  const evidence = JSON.parse(await readFile(record, "utf8"));
  assert(evidence.exposure.includes("manual"));
  assert(evidence.exposure.includes("whoami"));
  assert(!evidence.exposure.includes("launch"));
  assert(!evidence.exposure.includes("read_handoff"));
  assert(
    evidence.listed.includes("launch"),
    "Fixture verifies the broader catalog is narrowed by current capabilities",
  );
  assert.equal(evidence.denied, true);
  await expect
    .poll(() => page.evaluate(() => window.piExecutions.map((event) => event.to)))
    .toContain("blocked");
  await page.evaluate((id) => window.desktop.input(id, "x"), launched.id);
  await expect
    .poll(() => page.evaluate(() => window.piExecutions.map((event) => event.to)))
    .toContain("idle");
  const snapshot = JSON.stringify(await page.evaluate(() => window.desktop.workspace()));
  assert(!snapshot.includes("FOOM_TOKEN"));
  assert(!snapshot.includes("FOOM_CONTROL_TOKEN"));
  await page.evaluate((id) => window.desktop.kill(id), launched.id);
  await expect
    .poll(async () => {
      try {
        await access(evidence.extension);
        return false;
      } catch {
        return true;
      }
    })
    .toBe(true);
});
