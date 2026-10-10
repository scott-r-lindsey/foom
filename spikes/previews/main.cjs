"use strict";
// Throwaway prototype for #221: Markdown and HTML preview tiles beside a
// terminal, with live reload. Not Foom code; see docs/previews.md.
//
//   electron spikes/previews/main.cjs demo   [--isolation=view|iframe] [--root=DIR --md=REL --html=REL]
//   electron spikes/previews/main.cjs verify [--isolation=view|iframe] [--board-csp=foom]
//   electron spikes/previews/main.cjs measure [--isolation=view|iframe]
//
// Run verify/measure under xvfb-run -a on Linux. Results print as JSON.

const { app, Menu, BrowserWindow, WebContentsView, ipcMain, nativeTheme, protocol, session, shell, dialog, webFrameMain } =
  require("electron");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { canonicalRoot, readInside, segmentsFor, inside } = require("./containment.cjs");
const { build, out: buildDir } = require("./build.cjs");

const repo = path.resolve(__dirname, "../..");
const argv = process.argv.slice(2).filter((a) => !a.startsWith("--") || a.includes("="));
const flags = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--") && a.includes("="))
    .map((a) => a.slice(2).split("=", 2)),
);
const MODE = argv.find((a) => !a.startsWith("--")) ?? "demo";
const ISOLATION = flags.isolation === "iframe" ? "iframe" : "view";
const FOOM_BOARD_CSP = flags["board-csp"] === "foom";
// Evidence only: drop the preview CSP to show the request filter blocks on its own.
const NO_PREVIEW_CSP = flags["preview-csp"] === "off";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "foom-previews-spike-"));

app.setPath("userData", path.join(scratch, "profile"));
app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  { scheme: "spike-app", privileges: { standard: true, secure: true } },
  // No bypassCSP, corsEnabled, stream or service workers.
  { scheme: "foom-preview", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const events = []; // guard decisions, for evidence
const record = (kind, detail) => events.push({ t: Math.round(performance.now()), kind, ...detail });
const previews = new Map();
let board;
let pty;
let boardInput = [];

// ---------------------------------------------------------------- previews

class Preview {
  constructor({ root, entry, title, network = false }) {
    this.id = crypto.randomBytes(16).toString("hex"); // opaque origin host
    this.root = canonicalRoot(root);
    this.entry = entry;
    this.title = title ?? entry;
    this.kind = /\.(md|markdown)$/i.test(entry) ? "markdown" : "html";
    this.network = network;
    this.origin = `foom-preview://${this.id}`;
    this.dirs = new Map(); // dir -> { watcher, names }
    this.timer = undefined;
    this.firstChange = undefined;
    this.reloads = 0;
    this.view = undefined;
    this.expected = new Set();
  }
  get url() {
    return `${this.origin}${this.entry}`;
  }
  watch(file) {
    const dir = path.dirname(file);
    let entry = this.dirs.get(dir);
    if (!entry) {
      if (this.dirs.size >= 64) return record("watch-cap", { id: this.id });
      let watcher;
      try {
        // Directory watches survive atomic rename-over saves on every platform.
        watcher = fs.watch(dir, { persistent: false }, (_type, name) => {
          if (!name || entry.names.has(String(name))) this.changed();
        });
      } catch {
        return;
      }
      watcher.on("error", () => {
        watcher.close();
        this.dirs.delete(dir);
        this.changed();
      });
      entry = { watcher, names: new Set() };
      this.dirs.set(dir, entry);
    }
    entry.names.add(path.basename(file));
  }
  changed() {
    // 120 ms trailing debounce with a one-second maximum wait, for agents that
    // write in bursts without starving the preview during a long burst.
    const now = Date.now();
    this.firstChange ??= now;
    clearTimeout(this.timer);
    const wait = Math.min(120, Math.max(0, this.firstChange + 1000 - now));
    this.timer = setTimeout(() => {
      this.firstChange = undefined;
      void reloadPreview(this);
    }, wait);
  }
  close() {
    clearTimeout(this.timer);
    for (const { watcher } of this.dirs.values()) watcher.close();
    this.dirs.clear();
    previews.delete(this.id);
    if (this.view) {
      board.contentView.removeChildView(this.view);
      this.view.webContents.close();
    }
    if (this.session) void this.session.clearStorageData();
    else void session.defaultSession.clearStorageData({ origin: this.origin });
  }
}

function previewCsp(preview, markdown) {
  const ancestors = ISOLATION === "iframe" ? "spike-app://board" : "'none'";
  if (markdown)
    return `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${ancestors}`;
  const remote = preview.network ? " https:" : "";
  return [
    `default-src 'self' data: blob:${remote}`,
    `script-src 'self' 'unsafe-inline' blob:${remote}`,
    `style-src 'self' 'unsafe-inline'${remote}`,
    `img-src 'self' data: blob:${remote}`,
    `font-src 'self' data:${remote}`,
    `media-src 'self' data: blob:${remote}`,
    `connect-src 'self'${preview.network ? " https: wss:" : ""}`,
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");
}

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function statusPage(preview, status, reason) {
  const body = `<!doctype html><meta charset="utf-8"><title>${status}</title><style>body{font:14px system-ui;margin:24px;color:#9d93bd;background:#05040a}</style><p>${status === 404 ? "File not found. Waiting for it to appear." : "Foom will not show this file."} (${escapeHtml(reason)})</p>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "cache-control": "no-store" },
  });
}

function runtimeAsset(name) {
  const files = { "markdown.js": [path.join(buildDir, "markdown.js"), "text/javascript"], "markdown.css": [path.join(__dirname, "runtime/markdown.css"), "text/css"] };
  const file = files[name];
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(fs.readFileSync(file[0]), { headers: { "content-type": file[1], "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

function servePreview(request) {
  const url = new URL(request.url);
  const preview = previews.get(url.host);
  if (!preview || request.method !== "GET") return new Response("Not found", { status: 404 });
  if (url.pathname.startsWith("/__foom__/")) return runtimeAsset(url.pathname.slice(10));
  const result = readInside(preview.root, url.pathname);
  if (result.status === 200) preview.watch(result.real);
  else if (result.status === 404) {
    // Watch where a missing file would appear, so an agent's later write shows it.
    const parsed = segmentsFor(url.pathname);
    if (parsed.segments) {
      const candidate = path.join(preview.root, ...parsed.segments);
      try {
        if (inside(preview.root, fs.realpathSync.native(path.dirname(candidate)))) preview.watch(candidate);
      } catch {}
    }
  }
  record("serve", { id: preview.id, path: url.pathname, status: result.status, reason: result.reason });
  if (result.status !== 200) return statusPage(preview, result.status, result.reason);
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
  };
  if (result.type.startsWith("text/markdown") && !url.searchParams.has("raw")) {
    // Inline the source as JSON so rendering is synchronous: scroll restoration
    // and print see the final layout. Escaping "<" keeps it inside the script.
    const json = JSON.stringify(result.body.toString("utf8")).replace(/</g, "\\u003c");
    const page = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(path.basename(result.real))}</title><link rel="stylesheet" href="/__foom__/markdown.css"></head><body><main id="content"></main><script type="application/json" id="source">${json}</script><script src="/__foom__/markdown.js"></script></body></html>`;
    return new Response(page, { headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": previewCsp(preview, true) } });
  }
  if (!NO_PREVIEW_CSP) headers["content-security-policy"] = previewCsp(preview, false);
  return new Response(result.body, { headers: { ...headers, "content-type": result.type } });
}

function lockSession(ses, allow) {
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    record("permission-request", { permission });
    callback(false);
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    record("permission-check", { permission });
    return false;
  });
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    record("display-media", {});
    callback({});
  });
  ses.on("will-download", (event, item) => {
    record("download-blocked", { url: item.getURL() });
    event.preventDefault();
  });
  ses.webRequest.onBeforeRequest((details, callback) => {
    const ok = allow(details.url);
    if (!ok) record("request-blocked", { url: details.url.slice(0, 120) });
    callback({ cancel: !ok });
  });
  ses.setSpellCheckerEnabled(false);
}

function sameOrigin(preview, url) {
  try {
    return new URL(url).origin === preview.origin || new URL(url).host === preview.id;
  } catch {
    return false;
  }
}

function external(url) {
  record("external-request", { url });
  if (MODE !== "demo" || !/^https?:/i.test(url)) return;
  void dialog
    .showMessageBox(board, { type: "question", buttons: ["Open", "Cancel"], defaultId: 1, cancelId: 1, message: "Open link in your browser?", detail: url })
    .then(({ response }) => response === 0 && shell.openExternal(url));
}

/** Main frame: same-origin Markdown only. Subframes: same origin. Else external. */
function guardNavigation(preview, details, isMainFrame = details.isMainFrame) {
  const { url } = details;
  // Loads that main or the trusted board started (iframe src) are expected once.
  if (preview.expected.delete(url)) return record("navigation-expected", { url: url.slice(0, 120), isMainFrame });
  const allowed = sameOrigin(preview, url) && (!isMainFrame || /\.(md|markdown)$/i.test(new URL(url).pathname));
  record(allowed ? "navigation-allowed" : "navigation-blocked", { url: url.slice(0, 120), isMainFrame });
  if (allowed) return;
  details.preventDefault();
  if (/^(https?|mailto):/i.test(url) && isMainFrame) external(url);
}

const FOOM_SHORTCUT = (input) => input.type === "keyDown" && input.control && input.shift && input.key.toLowerCase() === "b";

function attachView(preview) {
  const partition = `preview-${preview.id}`; // no "persist:": memory only
  preview.session = session.fromPartition(partition, { cache: false });
  preview.session.protocol.handle("foom-preview", servePreview);
  lockSession(preview.session, (url) => url.startsWith(`${preview.origin}/`) || /^(data|blob):/.test(url) || (preview.network && /^(https|wss):/.test(url)));
  const view = new WebContentsView({
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: MODE === "demo",
      disableDialogs: true,
      autoplayPolicy: "user-gesture-required",
      // no preload
    },
  });
  preview.view = view;
  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    record("window-open-denied", { url: url.slice(0, 120) });
    if (/^https?:/i.test(url)) external(url);
    return { action: "deny" };
  });
  wc.on("will-frame-navigate", (details) => guardNavigation(preview, details));
  wc.on("will-redirect", (details) => {
    if (!sameOrigin(preview, details.url)) details.preventDefault();
  });
  wc.on("will-attach-webview", (event) => event.preventDefault());
  wc.on("before-input-event", (event, input) => {
    // Without this, a focused preview swallows Foom's before-input shortcuts.
    if (FOOM_SHORTCUT(input)) {
      record("shortcut-forwarded", { id: preview.id });
      event.preventDefault();
      board.webContents.send("spike:shortcut", "panel");
    }
  });
  wc.on("console-message", (details) => {
    if (/Content Security Policy/.test(details.message)) record("preview-csp", { message: details.message.slice(0, 200) });
  });
  wc.on("render-process-gone", (_event, details) => record("preview-gone", { id: preview.id, reason: details.reason }));
  view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#05040a" : "#f3f0fa");
  view.setVisible(false); // until the board reports a rectangle
  board.contentView.addChildView(view);
  void wc.loadURL(preview.url);
}

function openPreview(options) {
  const preview = new Preview(options);
  previews.set(preview.id, preview);
  if (ISOLATION === "view") attachView(preview);
  else preview.expected.add(preview.url);
  return preview;
}

/** A uniform handle on the preview document for both isolation modes. */
function frameOf(preview) {
  if (ISOLATION === "view") return preview.view.webContents.mainFrame;
  return board.webContents.mainFrame.framesInSubtree.find((f) => f !== board.webContents.mainFrame && f.url.startsWith(preview.origin));
}
async function evaluate(preview, code, wait = 2000) {
  const frame = frameOf(preview);
  if (!frame) throw new Error("No preview frame");
  // A frame that is mid-reload or detached may never answer.
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Frame did not answer")), wait);
  });
  return Promise.race([frame.executeJavaScript(code), timeout]).finally(() => clearTimeout(timer));
}

async function reloadPreview(preview) {
  preview.reloads++;
  const frame = frameOf(preview);
  if (!frame) return;
  let scroll = [0, 0];
  try {
    // An isolated world shares the DOM but not page globals, so a hostile page
    // cannot lie about its position; values are still validated.
    const value =
      ISOLATION === "view"
        ? await preview.view.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: "[scrollX, scrollY]" }])
        : await frame.executeJavaScript("[scrollX, scrollY]");
    if (Array.isArray(value) && value.every((n) => Number.isFinite(n) && n >= 0 && n < 1e7)) scroll = value;
  } catch {}
  record("reload", { id: preview.id, scroll });
  const restore = `scrollTo(${scroll[0]}, ${scroll[1]})`;
  if (ISOLATION === "view") {
    const wc = preview.view.webContents;
    wc.once("did-finish-load", () => void wc.executeJavaScriptInIsolatedWorld(1001, [{ code: restore }]).catch(() => {}));
    wc.reloadIgnoringCache();
  } else {
    frame.reload();
    const done = (_e, isMain, processId, routingId) => {
      const loaded = !isMain && webFrameMain.fromId(processId, routingId);
      if (!loaded || !loaded.url.startsWith(preview.origin)) return;
      board.webContents.removeListener("did-frame-finish-load", done);
      void loaded.executeJavaScript(restore).catch(() => {});
    };
    board.webContents.on("did-frame-finish-load", done);
  }
}

// ---------------------------------------------------------------- board

function trusted(event) {
  if (event.sender !== board.webContents || event.senderFrame !== board.webContents.mainFrame || !event.senderFrame.url.startsWith("spike-app://board/"))
    throw new Error("Untrusted sender");
}

function boardAssets() {
  const snapshots = new Map();
  const handler = (request) => {
    const url = new URL(request.url);
    if (url.host !== "board") return new Response("Not found", { status: 404 });
    if (url.pathname.startsWith("/__snapshot/")) {
      const png = snapshots.get(url.pathname.slice(12, 44));
      return png ? new Response(png, { headers: { "content-type": "image/png" } }) : new Response("", { status: 404 });
    }
    const files = {
      "/index.html": [path.join(__dirname, "runtime/board.html"), "text/html"],
      "/board.css": [path.join(__dirname, "runtime/board.css"), "text/css"],
      "/board.js": [path.join(buildDir, "board.js"), "text/javascript"],
      "/xterm.css": [path.join(repo, "node_modules/@xterm/xterm/css/xterm.css"), "text/css"],
    };
    const file = files[url.pathname];
    if (!file) return new Response("Not found", { status: 404 });
    let body = fs.readFileSync(file[0], "utf8");
    if (url.pathname === "/index.html")
      body = body.replaceAll("FRAME_SRC", ISOLATION === "iframe" && !FOOM_BOARD_CSP ? "; frame-src foom-preview:" : "");
    return new Response(body, { headers: { "content-type": file[1] } });
  };
  return { handler, snapshots };
}

function validBounds(list) {
  if (!Array.isArray(list) || list.length > 16) return false;
  return list.every(
    (b) =>
      b && typeof b === "object" && typeof b.id === "string" && previews.has(b.id) && typeof b.visible === "boolean" &&
      ["x", "y", "width", "height"].every((k) => Number.isFinite(b[k]) && b[k] >= 0 && b[k] <= 20000),
  );
}

function startTerminal(cwd) {
  const nodePty = require(path.join(repo, "node_modules/node-pty"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FOOM_") && k !== "CLAUDECODE"));
  const demoShell = MODE === "demo" && !process.env.SPIKE_DEMO_SCREENSHOT;
  const [shellPath, shellArgs] =
    process.platform === "win32" ? ["powershell.exe", []] : demoShell ? [process.env.SHELL || "/bin/bash", []] : ["/bin/bash", ["--norc", "--noprofile"]];
  env.PS1 = "worktree$ ";
  pty = nodePty.spawn(shellPath, shellArgs, { cwd, env, cols: 80, rows: 24, name: "xterm-256color" });
  pty.onData((data) => board?.webContents.send("spike:pty-data", data));
}

async function createBoard(previewSpecs, cwd) {
  const { handler, snapshots } = boardAssets();
  protocol.handle("spike-app", handler);
  if (ISOLATION === "iframe") {
    // Iframes share the board's session: one handler serves every preview, and
    // the board's request filter has to know every preview origin.
    protocol.handle("foom-preview", servePreview);
    lockSession(session.defaultSession, (url) => url.startsWith("spike-app://board/") || [...previews.keys()].some((id) => url.startsWith(`foom-preview://${id}/`)) || /^(data|blob|devtools):/.test(url));
  } else lockSession(session.defaultSession, (url) => url.startsWith("spike-app://board/") || /^(data|blob|devtools):/.test(url));

  board = new BrowserWindow({
    x: 0,
    y: 0,
    width: 1400,
    height: 860,
    // Shown in every mode (use xvfb-run): hidden windows throttle layout and paint.
    show: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#05040a" : "#f3f0fa",
    webPreferences: { preload: path.join(__dirname, "runtime/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false },
  });
  board.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  board.webContents.on("will-navigate", (event) => event.preventDefault());
  board.webContents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame) return;
    const frame = details.frame;
    const preview = [...previews.values()].find((p) => frame?.url.startsWith(p.origin) || frame?.origin === p.origin || p.expected.has(details.url));
    // A preview's own document is the iframe directly under the board.
    if (preview) guardNavigation(preview, details, frame?.parent === board.webContents.mainFrame);
    else {
      record("navigation-blocked", { url: details.url.slice(0, 120), isMainFrame: false });
      details.preventDefault();
    }
  });
  board.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown") boardInput.push(`${input.control ? "Ctrl+" : ""}${input.shift ? "Shift+" : ""}${input.key}`);
  });
  board.webContents.on("console-message", (details) => {
    if (/Content Security Policy|Refused/i.test(details.message))
      record(details.frame && details.frame !== board.webContents.mainFrame ? "preview-csp" : "board-csp", { message: details.message.slice(0, 200) });
  });

  for (const spec of previewSpecs) openPreview(spec);
  ipcMain.handle("spike:config", (event) => {
    trusted(event);
    return {
      isolation: ISOLATION,
      terminal: Boolean(cwd),
      previews: [...previews.values()].map((p) => ({ id: p.id, title: p.title, kind: p.kind, url: p.url })),
    };
  });
  ipcMain.on("spike:pty-write", (event, data) => {
    trusted(event);
    if (typeof data === "string" && data.length <= 65536) pty?.write(data);
  });
  ipcMain.on("spike:pty-resize", (event, cols, rows) => {
    trusted(event);
    if ([cols, rows].every((n) => Number.isInteger(n) && n > 0 && n < 1000)) pty?.resize(cols, rows);
  });
  ipcMain.on("spike:bounds", (event, list) => {
    trusted(event);
    if (!validBounds(list)) return record("bounds-rejected", {});
    // Board CSS pixels -> window DIPs: the board's zoom applies to views too.
    const zoom = board.webContents.getZoomFactor();
    for (const b of list) {
      const view = previews.get(b.id).view;
      view.setBounds({ x: Math.round(b.x * zoom), y: Math.round(b.y * zoom), width: Math.round(b.width * zoom), height: Math.round(b.height * zoom) });
      if (view.webContents.getZoomFactor() !== zoom) view.webContents.setZoomFactor(zoom);
      view.setVisible(b.visible && b.width > 0 && b.height > 0);
    }
  });
  ipcMain.handle("spike:overlay", async (event, open) => {
    trusted(event);
    if (ISOLATION !== "view" || typeof open !== "boolean") return [];
    const shots = [];
    for (const preview of previews.values()) {
      if (!open) {
        preview.view.setVisible(true);
        continue;
      }
      const started = performance.now();
      let image;
      try {
        image = await preview.view.webContents.capturePage();
      } catch (error) {
        // A hidden or zero-sized view has no frame to capture.
        record("snapshot-failed", { id: preview.id, error: String(error.message) });
        preview.view.setVisible(false);
        continue;
      }
      const key = crypto.randomBytes(16).toString("hex");
      snapshots.set(key, image.toPNG());
      record("snapshot", { id: preview.id, ms: Math.round(performance.now() - started) });
      preview.view.setVisible(false);
      shots.push({ id: preview.id, src: `spike-app://board/__snapshot/${key}` });
    }
    if (!open) snapshots.clear();
    return shots;
  });
  if (cwd) startTerminal(cwd);
  await board.loadURL("spike-app://board/index.html");
  return board;
}

// ---------------------------------------------------------------- harness

const step = (name) => process.stderr.write(`step ${Math.round(performance.now())} ${name}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 8000, step = 20) {
  const deadline = performance.now() + timeout;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    if (performance.now() > deadline) throw new Error("Timed out");
    await sleep(step);
  }
}

function countingServer() {
  const hits = [];
  let connections = 0;
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.end("reached");
  });
  server.on("connection", () => connections++);
  server.on("upgrade", (req, socket) => {
    hits.push(`upgrade ${req.url}`);
    socket.destroy();
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, hits, get connections() { return connections; }, close: () => server.close() })),
  );
}

function makeWorktree(port) {
  const base = path.join(scratch, "fixture");
  const root = path.join(base, "worktree");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  for (const dir of ["demo", "hostile"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const name of fs.readdirSync(path.join(__dirname, "fixtures", dir))) {
      const text = fs.readFileSync(path.join(__dirname, "fixtures", dir, name), "utf8");
      fs.writeFileSync(path.join(root, dir, name), text.replaceAll("PORT", String(port)));
    }
  }
  fs.writeFileSync(path.join(root, ".env"), "TOKEN=do-not-serve");
  fs.writeFileSync(path.join(root, ".git", "config"), "[core]");
  fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE-SECRET");
  fs.writeFileSync(path.join(root, "big.bin"), Buffer.alloc(17 * 1024 * 1024));
  try {
    fs.symlinkSync(outside, path.join(root, "escape-dir"), "dir");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escape-file.txt"));
    fs.symlinkSync(path.join(root, "demo", "README.md"), path.join(root, "inside-link.md"));
  } catch (error) {
    record("symlink-unavailable", { error: String(error.code) });
  }
  return root;
}

async function screenshot(name) {
  if (process.platform !== "linux" || !process.env.DISPLAY) return null;
  const file = path.join(__dirname, "results", `${name}.png`);
  await new Promise((resolve) => execFile("import", ["-window", "root", "-crop", "1400x860+0+0", file], () => resolve()));
  return path.relative(repo, file);
}

const reloadedSince = async (preview, origin) => until(async () => {
  const now = await evaluate(preview, "document.readyState === 'complete' && performance.timeOrigin", 100);
  return now && now !== origin ? now : false;
});

async function liveReload(preview, root) {
  const file = path.join(root, "demo", "page.html");
  const css = path.join(root, "demo", "style.css");
  const results = {};
  const timeOrigin = () => evaluate(preview, "performance.timeOrigin");
  const time = async (name, mutate) => {
    await sleep(400);
    const before = await timeOrigin();
    const reloads = preview.reloads;
    const started = performance.now();
    await mutate();
    await reloadedSince(preview, before);
    const ms = Math.round(performance.now() - started);
    await sleep(700); // catch trailing reloads from the same burst
    results[name] = { ms, reloads: preview.reloads - reloads };
  };
  const original = fs.readFileSync(file, "utf8");
  await evaluate(preview, "scrollTo(0, 1200)");
  await time("directWrite", () => fs.writeFileSync(file, original.replace("HTML preview</h1>", "HTML preview (edited)</h1>")));
  results.scrollAfterReload = await until(() => evaluate(preview, "scrollY > 0 && scrollY"), 2000).catch(() => 0);
  await time("atomicRename", () => {
    fs.writeFileSync(`${file}.tmp`, original);
    fs.renameSync(`${file}.tmp`, file);
  });
  await time("burst20", async () => {
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(file, `${original}<!-- ${i} -->`);
      await sleep(10);
    }
  });
  await time("assetCss", () => fs.appendFileSync(css, "\n/* touched */\n"));
  await time("deleteThenCreate", async () => {
    fs.rmSync(file);
    await sleep(300);
    fs.writeFileSync(file, original);
  });
  results.titleAfter = await evaluate(preview, "document.title");
  return results;
}

async function setFrame(preview, url) {
  preview.expected.add(url);
  await board.webContents.executeJavaScript(`document.querySelector('[data-preview="${preview.id}"] iframe').src = ${JSON.stringify(url)}`);
}

async function verify() {
  const server = await countingServer();
  const root = makeWorktree(server.port);
  const hostile = { root, entry: "/hostile/hostile.html", title: "hostile.html" };
  const friendly = { root, entry: "/demo/page.html", title: "page.html" };
  const markdown = { root, entry: "/hostile/hostile.md", title: "hostile.md" };
  // The hostile page needs the other preview's id, so create ids first.
  await createBoard([friendly, markdown, { ...hostile, entry: "/hostile/blank.txt" }], root);
  const [other, md, attacker] = [...previews.values()];
  attacker.entry = `/hostile/hostile.html?port=${server.port}&other=${other.id}`;
  if (ISOLATION === "view") await attacker.view.webContents.loadURL(attacker.url);
  else await setFrame(attacker, attacker.url);

  const result = { isolation: ISOLATION, previewCsp: !NO_PREVIEW_CSP, boardCsp: FOOM_BOARD_CSP ? "foom (unchanged)" : ISOLATION === "iframe" ? "foom + frame-src foom-preview:" : "foom (unchanged)", electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform };
  if (ISOLATION === "iframe" && FOOM_BOARD_CSP) {
    await sleep(2500);
    result.framesLoaded = board.webContents.mainFrame.framesInSubtree.filter((f) => f.url.startsWith("foom-preview:")).length;
    result.previewRequests = events.filter((e) => e.kind === "serve").length;
    result.cspEvents = events.filter((e) => e.kind === "board-csp").slice(0, 3);
    return { result, server };
  }
  step('await until(() => evalua');
  await until(() => evaluate(attacker, "document.title === 'done'"), 30000, 100);
  result.hostile = await evaluate(attacker, "window.__results");
  result.storageVisibleToOtherPreview = await evaluate(other, "localStorage.getItem('hostile')");
  result.markdown = await until(() =>
    evaluate(md, `({ rendered: !!document.querySelector('#content h1'), pwned: window.__pwned ?? null, scripts: [...document.scripts].map((s) => s.type || s.src.replace(location.origin, '')), rawHtmlShownAsText: document.body.textContent.includes('<script>window.__pwned'), javascriptLinks: document.querySelectorAll('a[href^="javascript"], a[href^="vbscript"], a[href^="data"], a[href^="file"]').length, iframes: document.querySelectorAll('iframe').length, onHandlers: [...document.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => a.name.startsWith('on'))).length, hrefs: [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')), images: [...document.images].map((i) => i.getAttribute('src')) })`).then((v) => v.rendered && v),
  );
  step('result.mdLinkNavigation ');
  result.mdLinkNavigation = await (async () => {
    await evaluate(md, "document.querySelector('a[href=\"../demo/other.md\"]').click()");
    return until(() => evaluate(md, "location.pathname === '/demo/other.md' && document.querySelector('h1')?.textContent"), 4000).catch(() => "not navigated");
  })();

  step('// Navigation attempts');
  // Navigation attempts, each recorded by the guards.
  const navStart = events.length;
  const navUrl = `${attacker.origin}/hostile/nav.html?port=${server.port}`;
  if (ISOLATION === "view") await attacker.view.webContents.loadURL(navUrl);
  else await setFrame(attacker, navUrl);
  attacker.entry = "/hostile/nav.html";
  await until(() => evaluate(attacker, "document.title === 'nav-done'"), 15000, 100).catch(() => null);
  result.navigation = {
    finalUrl: (await evaluate(attacker, "location.href").catch(() => "frame gone")).replace(attacker.id, "<id>"),
    title: await evaluate(attacker, "document.title").catch(() => null),
    boardUrl: board.webContents.getURL(),
    windows: BrowserWindow.getAllWindows().length,
    guard: events.slice(navStart).filter((e) => e.kind !== "serve").map(({ kind, url, isMainFrame }) => ({ kind, url: url?.replace(attacker.id, "<id>"), isMainFrame })),
  };

  step('// Shortcuts while');
  // Shortcuts while the preview has keyboard focus.
  boardInput = [];
  if (ISOLATION === "view") {
    attacker.view.webContents.focus();
    attacker.view.webContents.sendInputEvent({ type: "keyDown", keyCode: "B", modifiers: ["control", "shift"] });
  } else {
    await board.webContents.executeJavaScript(`document.querySelector('[data-preview="${attacker.id}"] iframe').focus()`);
    board.webContents.sendInputEvent({ type: "keyDown", keyCode: "B", modifiers: ["control", "shift"] });
  }
  await sleep(300);
  result.shortcut = { boardBeforeInputSaw: boardInput.filter((k) => k.endsWith("B") || k.endsWith("b")), forwardedFromPreview: events.filter((e) => e.kind === "shortcut-forwarded").length };
  await board.webContents.executeJavaScript("window.__board.openPanel(false)");

  step('// Theme follows');
  // Theme follows nativeTheme.themeSource, which Foom sets from its setting.
  result.theme = {};
  for (const source of ["dark", "light"]) {
    nativeTheme.themeSource = source;
    await sleep(800);
    result.theme[source] = { html: await evaluate(other, "matchMedia('(prefers-color-scheme: dark)').matches"), markdownBg: await evaluate(md, "getComputedStyle(document.documentElement).backgroundColor").catch(() => null) };
  }
  nativeTheme.themeSource = "system";

  step('result.liveReload =');
  result.liveReload = await liveReload(other, root);

  step('// Composition:');
  // Composition: board panel and scrim over the previews.
  result.screenshots = { normal: await screenshot(`${ISOLATION}-tiles`) };
  if (ISOLATION === "view") {
    // Without the snapshot swap, views cover board UI (panel, scrim).
    await board.webContents.executeJavaScript("window.__board.panelWithoutSnapshots()");
    await sleep(400);
    result.screenshots.panelWithoutSnapshots = await screenshot("view-panel-covered");
    await board.webContents.executeJavaScript("window.__board.panelWithoutSnapshots(false)");
  }
  await board.webContents.executeJavaScript("window.__board.openPanel(true)");
  await sleep(400);
  result.screenshots.panel = await screenshot(`${ISOLATION}-panel`);
  result.snapshotMs = events.filter((e) => e.kind === "snapshot").map((e) => e.ms);
  await board.webContents.executeJavaScript("window.__board.openPanel(false)");

  result.network = { serverConnections: server.connections, serverHits: server.hits };
  result.permissionEvents = [...new Set(events.filter((e) => e.kind.startsWith("permission")).map((e) => `${e.kind}:${e.permission}`))];
  result.blockedRequests = events.filter((e) => e.kind === "request-blocked").length;
  result.downloadsBlocked = events.filter((e) => e.kind === "download-blocked").length;
  result.serveRefusals = events.filter((e) => e.kind === "serve" && e.status !== 200).map((e) => `${e.status} ${e.reason} ${e.path.slice(0, 60)}`);

  step('// Closing stops');
  // Closing stops watchers and drops storage.
  const watched = other.dirs.size;
  other.close();
  result.watchersBeforeClose = watched;
  result.watchersAfterClose = other.dirs.size;
  return { result, server };
}

function metrics() {
  const byType = {};
  for (const p of app.getAppMetrics()) {
    const entry = (byType[p.type] ??= { count: 0, workingSetMB: 0 });
    entry.count++;
    entry.workingSetMB += p.memory.workingSetSize / 1024;
  }
  for (const v of Object.values(byType)) v.workingSetMB = Math.round(v.workingSetMB);
  const total = Object.values(byType).reduce((sum, v) => sum + v.workingSetMB, 0);
  return { total, byType };
}

async function measure() {
  const root = repo;
  const specs = [
    { root, entry: "/docs/architecture.md", title: "architecture.md" },
    { root, entry: "/docs/product.md", title: "product.md" },
    { root, entry: "/docs/agents.md", title: "agents.md" },
    { root, entry: "/docs/mockups/tiles.html", title: "tiles.html" },
    { root, entry: "/docs/mockups/tile-panels.html", title: "tile-panels.html" },
    { root, entry: "/docs/mockups/settings.html", title: "settings.html" },
  ];
  // Baseline: the board and terminal alone.
  await createBoard([], repo);
  await sleep(2500);
  const baseline = metrics();
  const started = performance.now();
  for (const spec of specs) openPreview(spec);
  await board.webContents.reload(); // the board reads its preview list at startup
  const list = [...previews.values()];
  await until(async () => (await Promise.all(list.map((p) => evaluate(p, "location.protocol === 'foom-preview:' && document.readyState === 'complete' && !!document.body.firstElementChild").catch(() => false)))).every(Boolean), 20000, 50);
  const loadMs = Math.round(performance.now() - started);
  await sleep(3000);
  const six = metrics();

  // Resize: 30 window-width steps (the same relayout a gutter drag causes);
  // time until every preview reports its new width.
  const widths = () => Promise.all(list.map((p) => evaluate(p, "innerWidth")));
  const resize = [];
  for (let step = 0; step < 30; step++) {
    const before = await widths();
    const t = performance.now();
    board.setContentSize(1400 - 12 * (step + 1), 860);
    const settled = await until(async () => (await widths()).every((w, i) => w !== before[i]), 2000, 4).catch(() => false);
    resize.push(settled ? performance.now() - t : Number.POSITIVE_INFINITY);
  }
  resize.sort((a, b) => a - b);
  const snapshotStart = performance.now();
  await board.webContents.executeJavaScript("window.__board.openPanel(true)");
  const overlayMs = Math.round(performance.now() - snapshotStart);
  await board.webContents.executeJavaScript("window.__board.openPanel(false)");

  const shot = await screenshot(`${ISOLATION}-six`);
  // Zoom: views must follow the board's zoom factor explicitly.
  board.setContentSize(1400, 860);
  board.webContents.setZoomFactor(1.5);
  await sleep(800);
  const zoom = ISOLATION === "view" ? { viewZoom: list[0].view.webContents.getZoomFactor(), viewBounds: list[0].view.getBounds(), boardRectCss: await board.webContents.executeJavaScript(`window.__board.previewRect(${JSON.stringify(list[0].id)})`) } : { frameDevicePixelRatio: await evaluate(list[0], "devicePixelRatio") };

  const blocked = [
    ...new Set([
      ...events.filter((e) => e.kind === "request-blocked").map((e) => new URL(e.url).host),
      ...events.filter((e) => e.kind === "preview-csp").flatMap((e) => e.message.match(/https?:\/\/[^/'\s]+/g) ?? []),
    ]),
  ];
  return {
    result: {
      isolation: ISOLATION,
      electron: process.versions.electron,
      baseline,
      sixPreviews: six,
      addedMB: six.total - baseline.total,
      perPreviewMB: Math.round((six.total - baseline.total) / 6),
      loadSixMs: loadMs,
      resizeMs: { median: Math.round(resize[15]), p90: Math.round(resize[27]), max: Math.round(resize[29]) },
      overlaySnapshotMs: overlayMs,
      zoom,
      blockedHostsFromMockups: blocked,
      screenshot: shot,
    },
  };
}

async function demo() {
  const root = flags.root ? path.resolve(flags.root) : (() => {
    const r = path.join(scratch, "worktree");
    fs.cpSync(path.join(__dirname, "fixtures", "demo"), path.join(r, "demo"), { recursive: true });
    return r;
  })();
  const md = flags.md ?? "/demo/README.md";
  const html = flags.html ?? "/demo/page.html";
  await createBoard([
    { root, entry: md.startsWith("/") ? md : `/${md}`, title: md },
    { root, entry: html.startsWith("/") ? html : `/${html}`, title: html },
  ], root);
  if (process.env.SPIKE_DEMO_SCREENSHOT) {
    await sleep(2500);
    await screenshot(process.env.SPIKE_DEMO_SCREENSHOT);
    app.quit();
  }
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    pty?.kill();
  } catch {}
  for (const preview of [...previews.values()]) preview.close();
  try {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  } catch (error) {
    process.stderr.write(`cleanup: ${error.message}\n`);
  }
}

app.on("window-all-closed", () => app.quit());
app.on("will-quit", cleanup);
app.whenReady().then(async () => {
  build();
  Menu.setApplicationMenu(null);
  if (MODE !== "demo")
    setTimeout(() => {
      process.stderr.write(`watchdog\n${JSON.stringify(events.slice(-15), null, 2)}\n`);
      cleanup();
      app.exit(2);
    }, 110000).unref();
  if (MODE === "demo") return demo();
  try {
    const { result, server } = await (MODE === "verify" ? verify() : measure());
    server?.close();
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (flags.out) fs.writeFileSync(path.resolve(flags.out), json);
    else process.stdout.write(json);
  } catch (error) {
    process.stderr.write(`${error.stack}\n${JSON.stringify(events.slice(-20), null, 2)}\n`);
    process.exitCode = 1;
  }
  cleanup();
  app.exit(process.exitCode ?? 0);
});
