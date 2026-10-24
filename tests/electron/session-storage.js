const { lstatSync, mkdtempSync, rmSync } = require("node:fs");
const { statfs } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

// Keep only paths allocated by this worker, with their original identity. Never
// sweep the shared directory: an unmarked older profile cannot prove ownership.
const allocated = new Map();
process.once("exit", () => {
  for (const [directory, identity] of allocated) {
    try {
      const current = lstatSync(directory);
      if (
        current.isDirectory() &&
        current.dev === identity.dev &&
        current.ino === identity.ino &&
        current.uid === identity.uid
      )
        rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "ENOENT")
        console.warn(`Unable to remove Chromium fixture ${directory}:`, error);
    }
  }
});

function allocate(root) {
  // Allocation and registration are synchronous, so process.exit cannot occur
  // between creating the directory and taking responsibility for its cleanup.
  const directory = mkdtempSync(path.join(root, "foom-chromium-"));
  allocated.set(directory, lstatSync(directory));
  return directory;
}

// Chromium flushes disposable browser state during native shutdown,
// after Foom's quit barrier. Keep those writes off a contended Linux disk while
// leaving the actual Foom profile and repository fixtures on their usual disk.
async function createSessionData({
  platform = process.platform,
  temporary = tmpdir(),
  sharedMemory = "/dev/shm",
} = {}) {
  if (platform === "linux") {
    try {
      const filesystem = await statfs(sharedMemory);
      // Avoid small container shared-memory mounts that cannot fit several apps.
      if (
        filesystem.type === 0x01021994 &&
        filesystem.bavail * filesystem.bsize >= 128 * 1024 * 1024
      )
        return allocate(sharedMemory);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "ENOSPC", "EROFS"].includes(error.code)) throw error;
    }
  }
  return allocate(temporary);
}

module.exports = { createSessionData };
