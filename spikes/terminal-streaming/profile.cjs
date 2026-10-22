const fs = require("node:fs");
const { TraceMap, originalPositionFor } = require("@jridgewell/trace-mapping");
const p = JSON.parse(fs.readFileSync(process.argv[2]));
const map = new TraceMap(
  JSON.parse(fs.readFileSync(process.argv[3] || "build/renderer/renderer.js.map")),
);
const nodes = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
const totals = {},
  self = {};
function loc(n) {
  const f = n.callFrame;
  if (f.url.includes("renderer.js")) {
    const pos = originalPositionFor(map, { line: f.lineNumber + 1, column: f.columnNumber });
    return `${pos.source || "?"}:${pos.line} ${f.functionName}`;
  }
  return `${f.url} ${f.functionName}`;
}
function classify(s) {
  if (/xterm\/src\/common/.test(s)) return "xterm parse/buffer";
  if (/xterm\/src\/browser|addon-webgl/.test(s)) return "xterm render/selection";
  if (/react-dom|react\//.test(s)) return "React";
  if (/light-activity|use-board-activity/.test(s)) return "lights/activity";
  if (/sound\//.test(s)) return "sound";
  if (/shell-controller|preload.*|electron.*renderer_init/.test(s)) return "IPC/controller";
  if (/\(idle\)|\(program\)|\(garbage collector\)/.test(s)) return s;
  return "other";
}
for (let i = 0; i < p.samples.length; i++) {
  let id = p.samples[i],
    n = nodes.get(id);
  let ms = p.timeDeltas[i] / 1000;
  const key = loc(n);
  self[key] = (self[key] || 0) + ms;
  let cat = classify(key);
  if (cat === "other") {
    let cur = id;
    while (parent.has(cur)) {
      cur = parent.get(cur);
      const c = classify(loc(nodes.get(cur)));
      if (c !== "other") {
        cat = c;
        break;
      }
    }
  }
  totals[cat] = (totals[cat] || 0) + ms;
}
console.log(
  JSON.stringify(
    {
      categoriesMs: totals,
      topSelfMs: Object.entries(self)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 45),
    },
    null,
    2,
  ),
);
