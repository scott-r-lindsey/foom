import { discoverRegistrations } from "./electron-registration.mjs";
import { parseShard, shardAssignments } from "../tests/electron/shard-assignment.js";

export function selectSuiteFiles(files, { shard, patterns }) {
  if (process.env.NODE_OPTIONS !== undefined) return files;
  try {
    const { count } = parseShard(shard);
    if (count === 1 && patterns.length === 0) return files;
    const assignments = shardAssignments(count);
    if (count > 1 && assignments.size === 0 && patterns.length === 0) return files;

    const inventory = discoverRegistrations(files, { shard, patterns });
    // The shard helper can suppress validation on a shard that is assigned
    // other tests. Keep failures in the unsharded baseline on every shard.
    const unsharded = shard === undefined ? inventory : discoverRegistrations(files);
    if (count > 1 && patterns.length === 0) {
      // Preserve the complete input on shards that receive a hash-assigned
      // case, as well as for unplanned shard counts.
      if (
        [...inventory.values()].some((entry) =>
          entry?.registrations?.some(({ name, sharded }) => sharded && !assignments.has(name)),
        )
      )
        return files;
    }
    const selected = files.filter((file) => {
      const entry = inventory.get(file);
      const baseline = unsharded.get(file);
      return (
        !baseline?.registrations?.length ||
        !entry?.registrations ||
        entry.registrations.some(({ matches }) => matches)
      );
    });
    return selected.length === 0 ? files : selected;
  } catch {
    // Leave invalid shard settings and other discovery failures to real workers.
    return files;
  }
}
