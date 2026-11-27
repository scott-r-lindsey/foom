const { createHash } = require("node:crypto");
const { shards } = require("./shard-plan.json");

function parseShard(shard) {
  if (shard === undefined) return { index: 0, count: 1 };
  const match = /^(\d+)\/(\d+)$/.exec(shard);
  if (!match) throw new Error("FOOM_ELECTRON_SHARD must be index/count");
  const index = Number(match[1]) - 1;
  const count = Number(match[2]);
  if (!Number.isSafeInteger(count) || count < 1 || count > 16 || index < 0 || index >= count)
    throw new Error("FOOM_ELECTRON_SHARD is outside the supported range");
  return { index, count };
}

function shardAssignments(count) {
  return new Map(
    (shards[count] ?? []).flatMap((tests, index) =>
      Object.keys(tests).map((name) => [name, index]),
    ),
  );
}

function hashBucket(name, count) {
  return createHash("sha256").update(name).digest().readUInt32BE(0) % count;
}

module.exports = { parseShard, shardAssignments, hashBucket };
