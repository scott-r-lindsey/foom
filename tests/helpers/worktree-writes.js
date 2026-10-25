const assert = require("node:assert/strict");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { gitSync } = require("./git.js");

function untrackedFiles(root) {
  return new Set(
    gitSync(["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean),
  );
}

// Preserve pre-existing developer files; report only files created by this run.
function guardWorktreeWrites(root = process.cwd()) {
  const before = untrackedFiles(root);
  const temporary = path.relative(root, tmpdir());
  const temporaryInsideWorktree =
    temporary !== "" &&
    temporary !== ".." &&
    !temporary.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(temporary);
  return () => {
    const leaks = [...untrackedFiles(root)].filter((file) => {
      const absolute = path.resolve(root, file);
      return (
        !before.has(file) &&
        !file.startsWith("test-results/") &&
        !(temporaryInsideWorktree && absolute.startsWith(path.resolve(tmpdir()) + path.sep))
      );
    });
    assert.deepEqual(leaks, [], "Tests created untracked files outside test-results or OS temp");
  };
}

module.exports = { guardWorktreeWrites };
