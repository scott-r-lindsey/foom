const { test: register } = require("node:test");
const { parseShard, shardAssignments, hashBucket } = require("./shard-assignment.js");

// Node's built-in sharding partitions files. Partition named top-level tests
// across every feature suite so measured assignments survive file moves.
const { index, count } = parseShard(process.env.FOOM_ELECTRON_SHARD);
const assignments = shardAssignments(count);
function test(name, ...args) {
  // Use the measured plan for each measured shard count. New/renamed tests and
  // other shard counts retain deterministic hashing until the next rebalance.
  const bucket = assignments.get(name) ?? hashBucket(name, count);
  if (bucket === index) return register(name, ...args);
}
module.exports = { test };
