"use strict";
// Bundles the board and the in-preview Markdown runtime with the repo's esbuild.
// Prints bundle sizes as JSON for docs/previews.md.
const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const out = path.join(__dirname, ".build");
function build() {
  fs.mkdirSync(out, { recursive: true });
  const common = { bundle: true, minify: true, format: "esm", target: "chrome140", logLevel: "silent" };
  esbuild.buildSync({ ...common, entryPoints: [path.join(__dirname, "runtime/board.mjs")], outfile: path.join(out, "board.js") });
  esbuild.buildSync({ ...common, entryPoints: [path.join(__dirname, "runtime/markdown.mjs")], outfile: path.join(out, "markdown.js"), format: "iife" });
  const size = (file) => {
    const body = fs.readFileSync(path.join(out, file));
    return { bytes: body.length, gzip: zlib.gzipSync(body).length };
  };
  return { markdown: size("markdown.js"), board: size("board.js") };
}
module.exports = { build, out };
if (require.main === module) process.stdout.write(`${JSON.stringify(build(), null, 2)}\n`);
