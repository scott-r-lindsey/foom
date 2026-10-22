const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { chmod, copyFile, mkdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { expect } = require("./test-policy.js");

// A native SEA fixture for the bundled Codex adapter. No config-provider installation
// or native home override; packaged Electron resolves home independently of HOME.
async function installManualAgent(home, bin) {
  const name = "codex";
  const executable = path.join(bin, name + (process.platform === "win32" ? ".exe" : ""));
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  const report = path.join(home, "manual-report.json");
  const script = path.join(home, "manual-agent.cjs");
  await writeFile(
    script,
    `
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 0.161.0'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('-c --no-alt-screen'); process.exit(0); }
(async () => {
  const url = process.env.FOOM_CONTROL_URL.replace('/control/v1', '/mcp');
  let session;
  const request = async (message) => {
    const response = await fetch(url, { method: 'POST', headers: {
      Authorization: 'Bearer ' + process.env.FOOM_CONTROL_TOKEN,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(session ? { 'Mcp-Session-Id': session, 'Mcp-Protocol-Version': '2025-11-25' } : {})
    }, body: JSON.stringify({ jsonrpc: '2.0', ...message }) });
    if (!response.ok) throw Error('HTTP ' + response.status);
    session ||= response.headers.get('mcp-session-id');
    if (response.status === 202) return;
    const body = await response.json();
    if (body.result?.isError || body.error) throw Error(JSON.stringify(body));
    return body.result;
  };
  const initialized = await request({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'manual-fixture', version: '1' } } });
  await request({ method: 'notifications/initialized' });
  const tools = await request({ id: 2, method: 'tools/list' });
  const list = await request({ id: 3, method: 'tools/call', params: { name: 'manual' } });
  let text = '', page = 0;
  for (;;) {
    const result = await request({ id: 4 + page, method: 'tools/call', params: { name: 'manual', arguments: { section: 'shortcuts', page } } });
    text += result.structuredContent.text;
    if (result.structuredContent.nextPage === undefined) break;
    page = result.structuredContent.nextPage;
  }
  fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ instructions: initialized.instructions, tools: tools.tools.map(t => t.name), sections: list.structuredContent.sections, text }));
})().catch(error => fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ error: String(error) })));
`,
  );
  const temporary = path.join(home, "manual-sea");
  await mkdir(temporary);
  const blob = path.join(temporary, "agent.blob");
  const config = path.join(temporary, "sea.json");
  await writeFile(
    config,
    JSON.stringify({
      main: script,
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgvExtension: "none",
    }),
  );
  execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "pipe" });
  if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", executable]);
  execFileSync(
    process.execPath,
    [
      path.join(__dirname, "../../node_modules/postject/dist/cli.js"),
      executable,
      "NODE_SEA_BLOB",
      blob,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
      ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
    ],
    { stdio: "pipe" },
  );
  if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", executable]);
  return report;
}

async function assertManualAgent(page, repository, report, index) {
  await expect
    .poll(async () => {
      const scan = await page.evaluate(() => window.desktop.scanAgents(true));
      return scan.agents.some((agent) => agent.id === "codex" && agent.path !== null);
    })
    .toBe(true);
  await page.evaluate(
    (repository) =>
      window.desktop.sidebarCommand({
        kind: "launch",
        repository,
        worktree: repository,
        run: "codex",
      }),
    repository,
  );
  let result;
  await expect
    .poll(async () => {
      try {
        result = JSON.parse(await readFile(report, "utf8"));
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);
  assert.equal(result.error, undefined);
  assert.ok(result.instructions.includes("For questions about using Foom, call manual."));
  assert.ok(result.tools.includes("manual"));
  assert.deepEqual(
    result.sections.map((section) => section.id),
    index.map((section) => section.id),
  );
  assert.equal(result.text, index.find((section) => section.id === "shortcuts").text);
  assert.match(result.text, /New Window/);
  let terminal;
  await expect
    .poll(async () => {
      terminal = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
        (entry) => entry.agent === "codex",
      );
      return terminal?.exitCode;
    })
    .toBe(0);
  await page.evaluate((id) => window.desktop.sidebarCommand({ kind: "close", id }), terminal.id);
}
module.exports = { installManualAgent, assertManualAgent };
