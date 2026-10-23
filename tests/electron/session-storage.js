const { mkdtemp, statfs } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

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
        return await mkdtemp(path.join(sharedMemory, "foom-chromium-"));
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "ENOSPC", "EROFS"].includes(error.code)) throw error;
    }
  }
  return mkdtemp(path.join(temporary, "foom-chromium-"));
}

module.exports = { createSessionData };
