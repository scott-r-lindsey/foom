// End to end (#222 spike, not Foom code): a real agent CLI, driven by the scripted
// loopback model, calls open_preview through Foom's patched control plane; the
// broker places the preview, and Electron shows it in an isolated view.
//   xvfb-run -a -s "-screen 0 1280x800x24" npx electron spikes/agent-previews/demo.mjs [codex|claude] [--out=results/demo.png]
import { app, BrowserWindow, WebContentsView, protocol, session } from "electron";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { startControl } from "./server.mjs";
import { startModel } from "./model.mjs";

const require = createRequire(import.meta.url);
const { Board } = require("./broker.cjs");
const { readInside } = require("../previews/containment.cjs");
const agent = process.argv.find((a) => a === "codex" || a === "claude") ?? "codex";
// none | load (refocus after load) | focus (refocus on the view's focus event) | detached (attach after load, plus focus guard)
const strategy = process.argv.find((a) => a.startsWith("--focus="))?.slice(8) ?? "none";
const typing = process.argv.includes("--keystrokes");
const focusLog = [];
const clicked = new Set(); // previews the human clicked (none in this run)
const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6);

protocol.registerSchemesAsPrivileged([
  { scheme: "foom-preview", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// #221's default HTML policy: scripts run only inside the preview's own origin.
const CSP =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";

const MOCKUP = `<!doctype html><meta charset="utf-8"><title>Checkout mockup</title>
<style>
:root{color-scheme:dark;--bg:#0f0d18;--card:#1a1726;--ink:#ece8f6;--dim:#9b94b4;--accent:#7c6cff}
body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--ink);display:grid;place-items:center;min-height:100vh}
.card{background:var(--card);border-radius:14px;padding:28px 32px;width:min(380px,85vw);display:grid;gap:14px}
h1{font-size:20px;margin:0}.row{display:flex;justify-content:space-between;color:var(--dim)}
.total{border-top:1px solid #2c2840;padding-top:12px;font-weight:600;display:flex;justify-content:space-between}
button{background:var(--accent);color:white;border:0;border-radius:9px;padding:11px;font:inherit;font-weight:600}
</style>
<div class="card"><h1>Checkout</h1>
<div class="row"><span>2 × Field notebook</span><span>$24.00</span></div>
<div class="row"><span>Shipping</span><span>$4.50</span></div>
<div class="total"><span>Total</span><span>$28.50</span></div>
<button>Pay $28.50</button></div>
<input id="grab" autofocus style="position:absolute;opacity:0">
<script>window.stolen="";addEventListener("keydown",e=>{if(e.key.length===1)window.stolen+=e.key},true);document.getElementById("grab").focus();</script>`;
// A page that keeps trying to take focus after it is attached.
const GRABBY = `<script>setInterval(()=>{window.focus();document.getElementById("grab").focus()},20)</script>`;

const BOARD = `<!doctype html><meta charset="utf-8">
<style>
:root{--bg:#0b0a12;--panel:#12101c;--line:#262236;--ink:#e6e2f2;--dim:#8a84a3;--accent:#7c6cff}
*{box-sizing:border-box}body{margin:0;height:100vh;display:grid;grid-template-columns:230px 1fr;background:var(--bg);color:var(--ink);font:13px/1.4 system-ui,sans-serif}
aside{background:var(--panel);border-right:1px solid var(--line);padding:12px;display:grid;align-content:start;gap:6px}
.repo{color:var(--dim);text-transform:uppercase;letter-spacing:.06em;font-size:11px;margin-top:6px}
.row{display:flex;gap:8px;align-items:center;padding:4px 6px;border-radius:6px}.row.sel{background:#1d1a2c}
.light{width:8px;height:8px;border-radius:50%;background:#3ccf91}.doc{width:10px;color:var(--dim)}
.sub{padding-left:22px}.by{color:var(--dim);font-size:11px;margin-left:auto}
main{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:6px}
.tile{border:1px solid var(--line);border-radius:8px;display:grid;grid-template-rows:30px 1fr;overflow:hidden;background:#0d0c15}
.tile.focused{border-color:var(--accent)}
.bar{display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid var(--line);background:#14121f;color:var(--dim)}
.bar b{color:var(--ink);font-weight:600}.badge{border:1px solid var(--line);border-radius:4px;padding:0 5px;font-size:11px}
.num{margin-left:auto}pre{margin:0;padding:10px;font:12px/1.45 ui-monospace,monospace;white-space:pre-wrap;color:#cfc9e6}
.empty{border:1px dashed var(--line);border-radius:8px;background:color-mix(in srgb,var(--accent) 5%,transparent)}
.arrived{box-shadow:inset 0 0 0 1px var(--accent);background:color-mix(in srgb,var(--accent) 8%,#0d0c15)}
</style>
<aside id="side"></aside><main id="tiles"></main>
<textarea id="keys" style="position:fixed;left:-50px;top:0;width:10px;height:10px;opacity:0"></textarea>
<script>
window.render = (s) => {
  side.innerHTML = '<div class="repo">shop</div>' +
    '<div class="row sel"><span class="light"></span><b>' + s.agentName + '</b><span class="by">checkout-ui</span></div>' +
    s.previews.map(p => '<div class="row sub"><span class="doc">▤</span>' + p.path + '<span class="by">' + (p.tile ? 'tile 2' : 'hidden') + '</span></div>').join('');
  const preview = s.previews.find(p => p.tile);
  tiles.innerHTML =
    '<section class="tile focused"><div class="bar"><span class="light"></span><b>shop › checkout-ui</b><span class="badge">' + s.badge + '</span><span class="num">1</span></div><pre id="term"></pre></section>' +
    (preview
      ? '<section class="tile arrived" id="t2"><div class="bar"><span class="doc">▤</span><b>' + preview.path + '</b><span class="badge">Preview</span><span>opened by ' + s.agentName + '</span><span class="num">2</span></div><div id="slot"></div></section>'
      : '<section class="empty" id="t2"></section>');
  term.textContent = s.log;
  if (document.activeElement === document.body) keys.focus();
  const slot = document.getElementById('slot');
  if (!slot) return null;
  const r = slot.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
};
</script>`;

// Top-level await would hold back Electron's ready event in an ES module main.
app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.exit(1);
});

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), "foom-agent-preview-demo-"));
  const worktree = join(scratch, "checkout-ui");
  await mkdir(join(worktree, "docs"), { recursive: true });
  await writeFile(join(worktree, "docs", "mockup.html"), MOCKUP + (process.argv.includes("--grabby") ? GRABBY : ""));
  await writeFile(join(worktree, "docs", "notes.md"), "# Notes\n\nTotals round half up.");

  const board = new Board({ landing: "t2", empty: ["t2"], focused: "t1" });
  const control = await startControl({ board });
  const model = await startModel([
    { tool: "open_preview", input: { path: "docs/mockup.html" } },
    { tool: "open_preview", input: { path: "docs/notes.md" } }, // board is full now: sidebar only
    { tool: "open_preview", input: { path: "docs/mockup.html" } }, // reuse: nothing moves
  ]);
  const agentName = agent === "codex" ? "Codex" : "Claude Code";
  const state = { agentName, badge: agent === "codex" ? "CX" : "CC", log: `$ ${agent} "Show me the mockup you wrote."\n`, previews: [] };
  const win = new BrowserWindow({ width: 1200, height: 680, show: true, backgroundColor: "#0b0a12", webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BOARD)}`);
  const views = new Map();

  async function render() {
    const bounds = await win.webContents.executeJavaScript(`render(${JSON.stringify(state)})`);
    for (const [id, view] of views) {
      const visible = state.previews.find((p) => p.previewId === id)?.tile;
      if (visible && bounds) view.setBounds(bounds);
      view.setVisible(Boolean(visible && bounds));
    }
  }

  function showPreview(record) {
    // One in-memory partition per preview; no preload; sandboxed; never focused.
    const ses = session.fromPartition(`preview-${record.previewId}`, { cache: false });
    ses.protocol.handle("foom-preview", (request) => {
      const url = new URL(request.url);
      const result = readInside(record.root, url.pathname);
      if (result.status !== 200) return new Response(null, { status: result.status });
      return new Response(result.body, {
        headers: { "content-type": result.type, "content-security-policy": CSP, "x-content-type-options": "nosniff", "cache-control": "no-store" },
      });
    });
    ses.setPermissionRequestHandler((_wc, _p, done) => done(false));
    ses.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(`foom-preview://${record.host}/`) && !/^(data|blob):/.test(details.url) }));
    const boardHadFocus = win.webContents.isFocused();
    const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, disableDialogs: true } });
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event) => event.preventDefault());
    if (strategy === "detached")
      view.webContents.once("did-finish-load", () => {
        win.contentView.addChildView(view);
        focusLog.push({ preview: record.path, event: "attached after load", viewFocused: view.webContents.isFocused(), boardFocused: win.webContents.isFocused() });
        void render();
      });
    else win.contentView.addChildView(view);
    views.set(record.previewId, view);
    view.webContents.on("focus", () => {
      focusLog.push({ preview: record.path, event: "view focus", boardHadFocus });
      // The human focuses a preview by clicking it; anything else is returned at once.
      if ((strategy === "focus" || strategy === "detached") && boardHadFocus && !clicked.has(record.previewId)) {
        win.webContents.focus();
        focusLog.push({ preview: record.path, event: "returned focus", boardFocused: win.webContents.isFocused() });
      }
    });
    view.webContents.on("did-finish-load", () => {
      focusLog.push({ preview: record.path, event: "loaded", viewFocused: view.webContents.isFocused(), boardFocused: win.webContents.isFocused() });
      // Mitigation under test: give focus back if the board had it when the agent asked.
      if (strategy === "load" && boardHadFocus && !win.webContents.isFocused()) {
        win.webContents.focus();
        focusLog.push({ preview: record.path, event: "refocused board", boardFocused: win.webContents.isFocused() });
      }
    });
    focusLog.push({ preview: record.path, event: strategy === "detached" ? "created (not attached)" : "attached", viewFocused: view.webContents.isFocused(), boardFocused: win.webContents.isFocused() });
    void view.webContents.loadURL(`foom-preview://${record.host}/${record.path.split("/").map(encodeURIComponent).join("/")}`);
  }

  // Main would do this in the preview host: react to the broker's placement.
  const open = control.broker.open.bind(control.broker);
  control.broker.open = (actor, input) => {
    const result = open(actor, input);
    if (!result.reused) {
      const record = control.broker.previews.get(result.previewId);
      const entry = { previewId: result.previewId, path: result.path, tile: record.tile, root: worktree, host: result.previewId.slice(3) };
      state.previews.push(entry);
      if (entry.tile) showPreview(entry);
    }
    state.log += `● open_preview ${input.path} → ${result.placement}${result.reused ? " (reused)" : ""}\n`;
    void render();
    return result;
  };

  const grant = control.grant(worktree, "demo-agent", { agent, name: agentName });
  const attachment = await control.control.prepareMcpLaunch(agent, control.endpoint);
  const server =
    agent === "claude"
      ? Object.keys(JSON.parse(await readFile(attachment.args[1], "utf8")).mcpServers)[0]
      : attachment.args[1].match(/mcp_servers\.([a-z0-9_]+)=/)[1];
  const home = join(scratch, "home");
  await mkdir(home);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: home,
    CLAUDE_CONFIG_DIR: home,
    ...grant.env,
    ANTHROPIC_BASE_URL: model.url,
    ANTHROPIC_API_KEY: "synthetic",
    OPENAI_API_KEY: "synthetic",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  const args =
    agent === "codex"
      ? ["exec", "--skip-git-repo-check", "--ephemeral", "-c", 'model_provider="synthetic"', "-c", `model_providers.synthetic={name="synthetic",base_url="${model.url}/v1",wire_api="responses"}`, "-c", 'model="synthetic"', ...attachment.args, "--", "Show me the mockup you wrote."]
      : ["-p", "--allowedTools", `mcp__${server}__open_preview`, ...attachment.args, "--", "Show me the mockup you wrote."];
  await render();
  const focusedBefore = BrowserWindow.getFocusedWindow()?.webContents.id ?? null;
  win.focus();
  await win.webContents.executeJavaScript("keys.focus()");
  const TEXT = "abcdefghij".repeat(30);
  let typist = null;
  if (typing) {
    typist = spawn("xdotool", ["type", "--delay", "12", TEXT], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 400)); // keys already flowing when the agent starts
  }
  const child = spawn(agent, args, { env, cwd: worktree, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => {
    const text = d.toString().replace(/foom_[0-9a-f]+/g, "foom_…");
    state.log += text.split("\n").filter((l) => /Synthetic|mcp|open_preview/i.test(l)).map((l) => `${l.slice(0, 90)}\n`).join("");
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (typist) await new Promise((r) => (typist.exitCode === null ? typist.on("exit", r) : r()));
  state.log += `\n[agent exited ${code}]\n`;
  await render();
  await new Promise((r) => setTimeout(r, 1200));
  const focusedAfter = BrowserWindow.getFocusedWindow()?.webContents.id ?? null;
  const previewFocused = [...views.values()].some((v) => v.webContents.isFocused());
  const summary = {
    agent: (await new Promise((resolve) => { const p = spawn(agent, ["--version"]); let s = ""; p.stdout.on("data", (d) => (s += d)); p.on("exit", () => resolve(s.trim())); })),
    exit: code,
    events: control.broker.events.map(({ action, path, outcome }) => ({ action, path, outcome })),
    boardFocusUnchanged: board.focused === "t1" && focusedBefore === focusedAfter,
    previewViewFocused: previewFocused,
    boardFocusedAtEnd: win.webContents.isFocused(),
    focusStrategy: strategy,
    focusLog,
    ...(typing
      ? {
          keysTyped: TEXT.length,
          keysInBoard: await win.webContents.executeJavaScript("keys.value.length"),
          keysInPreview: views.size ? await [...views.values()][0].webContents.executeJavaScript("window.stolen.length") : 0,
        }
      : {}),
    previewTitle: views.size ? await [...views.values()][0].webContents.executeJavaScript("document.title") : null,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (out) {
    // Window capture omits child views; swap each visible view for its snapshot (#221's overlay technique).
    for (const [id, view] of views) {
      if (!view.getVisible()) continue;
      const shot = (await view.webContents.capturePage()).toDataURL();
      await win.webContents.executeJavaScript(`(() => { const s = document.getElementById("slot"); if (s) s.style.background = "center / cover no-repeat url(${shot})"; })()`);
      view.setVisible(false);
    }
    await new Promise((r) => setTimeout(r, 200));
    const image = await win.capturePage();
    await writeFile(out, image.toPNG());
    await writeFile(out.replace(/\.png$/, ".json"), `${JSON.stringify(summary, null, 2)}\n`);
  }
  attachment.dispose();
  grant.dispose();
  await control.close();
  model.close();
  await rm(scratch, { recursive: true, force: true });
  app.quit();
}
