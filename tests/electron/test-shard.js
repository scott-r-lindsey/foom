const { test: register } = require("node:test");
const { createHash } = require("node:crypto");

// Node's built-in sharding partitions files. This suite shares fixture helpers
// in one file, so partition its named top-level tests before registering them.
const shard = process.env.FOOM_ELECTRON_SHARD;
let index = 0;
let count = 1;
if (shard !== undefined) {
  const match = /^(\d+)\/(\d+)$/.exec(shard);
  if (!match) throw new Error("FOOM_ELECTRON_SHARD must be index/count");
  index = Number(match[1]) - 1;
  count = Number(match[2]);
  if (!Number.isSafeInteger(count) || count < 1 || count > 16 || index < 0 || index >= count)
    throw new Error("FOOM_ELECTRON_SHARD is outside the supported range");
}
function test(name, ...args) {
  const bucket = createHash("sha256").update(name).digest().readUInt32BE(0) % count;
  if (bucket === index) return register(name, ...args);
}
module.exports = { test };
