const { mkdirSync } = require("node:fs");
const path = require("node:path");

const evidenceRoot = path.resolve(__dirname, "../../test-results");

// Resolve every capture against this worktree, independent of the caller's cwd.
function evidencePath(name) {
  const relative = name.replace(/^test-results[/\\]/, "");
  const target = path.resolve(evidenceRoot, relative);
  if (target !== evidenceRoot && !target.startsWith(evidenceRoot + path.sep)) {
    throw new Error(`Test evidence must stay under ${evidenceRoot}: ${name}`);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

module.exports = { evidencePath };
