// The board side of the spike. It has Foom's CSP and a narrow preload bridge;
// it only lays out tiles and reports preview rectangles to main.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

const bridge = window.spike;
const config = await bridge.config();
const tiles = document.getElementById("tiles");
const panel = document.getElementById("panel");
if (config.previews.length > 2) tiles.classList.add("many");

function tile(title, kind) {
  const element = document.createElement("section");
  element.className = `tile ${kind}`;
  const bar = document.createElement("div");
  bar.className = "bar";
  const label = document.createElement("span");
  label.textContent = title;
  const menu = document.createElement("button");
  menu.textContent = "Panel";
  menu.addEventListener("click", () => openPanel(true));
  bar.append(label, menu);
  const body = document.createElement("div");
  body.className = "body";
  element.append(bar, body);
  tiles.append(element);
  return body;
}

if (config.terminal) {
  const body = tile("bash — worktree", "terminal");
  const term = new Terminal({ fontSize: 13 });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(body);
  term.onData((data) => bridge.terminalWrite(data));
  bridge.onTerminal((data) => term.write(data));
  const refit = () => {
    fit.fit();
    bridge.terminalResize(term.cols, term.rows);
  };
  new ResizeObserver(refit).observe(body);
  refit();
}

const bodies = new Map();
for (const preview of config.previews) {
  const body = tile(`${preview.kind === "markdown" ? "MD" : "HTML"} ${preview.title}`, "preview");
  body.dataset.preview = preview.id;
  bodies.set(preview.id, body);
  if (config.isolation === "iframe") {
    const frame = document.createElement("iframe");
    // Distinct origin from the board, so allow-same-origin keeps the preview's
    // own origin rather than granting the board's. No allow-top-navigation,
    // forms, popups, modals or downloads.
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.setAttribute("allow", "");
    frame.referrerPolicy = "no-referrer";
    frame.src = preview.url;
    body.append(frame);
  }
}

let overlay = false;
function sendBounds() {
  if (config.isolation !== "view") return;
  const list = [];
  for (const [id, body] of bodies) {
    const r = body.getBoundingClientRect();
    list.push({ id, x: r.x, y: r.y, width: r.width, height: r.height, visible: !overlay });
  }
  bridge.bounds(list);
}
const observer = new ResizeObserver(sendBounds);
for (const body of bodies.values()) observer.observe(body);
window.addEventListener("resize", sendBounds);

let scrim;
async function openPanel(open) {
  overlay = open;
  panel.hidden = !open;
  if (open) {
    scrim = document.createElement("div");
    scrim.id = "scrim";
    document.body.append(scrim);
  } else scrim?.remove();
  if (config.isolation !== "view") return;
  // Views draw above the board's DOM; swap in snapshots while board UI is on top.
  const snapshots = open ? await bridge.overlay(true) : (await bridge.overlay(false), []);
  for (const body of bodies.values()) body.querySelector("img.snapshot")?.remove();
  for (const { id, src } of snapshots) {
    const img = document.createElement("img");
    img.className = "snapshot";
    img.alt = "";
    img.src = src;
    bodies.get(id)?.append(img);
  }
  sendBounds();
}
document.getElementById("close-panel").addEventListener("click", () => openPanel(false));
bridge.onShortcut((name) => {
  if (name === "panel") openPanel(!overlay);
});

// Harness hooks: the board is trusted spike code, driven by main's scenarios.
window.__board = {
  openPanel,
  panelWithoutSnapshots(open = true) {
    panel.hidden = !open;
    if (open) {
      scrim = document.createElement("div");
      scrim.id = "scrim";
      document.body.append(scrim);
    } else scrim?.remove();
  },
  setSplit(percent) {
    document.documentElement.style.setProperty("--split", `${percent}%`);
    sendBounds();
  },
  previewRect(id) {
    const r = bodies.get(id).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  },
};
sendBounds();
