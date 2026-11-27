import { discoverStaticRegistrations } from "./electron-registration.mjs";
import { readFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { runInNewContext } from "node:vm";
import { hashBucket, parseShard, shardAssignments } from "../tests/electron/shard-assignment.js";

// Inventory for the shard planner. This can collect generated cases, but
// running outside a worker cannot prove that the inventory is complete.
export function discoverRegistrations(files) {
  const registrations = new Map();
  for (const file of files) {
    const suiteRequire = createRequire(file);
    const size = registrations.size;
    const source = readFileSync(file, "utf8");
    function requireForDiscovery(specifier) {
      if (specifier === "./test-shard.js") {
        return {
          test(name) {
            if (typeof name !== "string" || !name || registrations.has(name))
              throw new Error(`Missing or duplicate Electron test name in ${file}`);
            registrations.set(name, file);
          },
        };
      }
      if (specifier === "node:test") return { afterEach() {} };
      if (/^(?:node:)?(?:module|process)$/.test(specifier))
        throw new Error("Worker-dependent Electron registration");
      return suiteRequire(specifier);
    }
    runInNewContext(
      source,
      {
        // Test options use the host platform. Names that depend on worker
        // state, argv or the environment cannot be resolved in the wrapper.
        process: new Proxy(
          {
            platform: process.platform,
            arch: process.arch,
            getBuiltinModule: (specifier) =>
              isBuiltin(specifier) ? requireForDiscovery(specifier) : undefined,
          },
          {
            get(target, key) {
              if (!Object.hasOwn(target, key))
                throw new Error("Worker-dependent Electron registration");
              return target[key];
            },
          },
        ),
        require: requireForDiscovery,
      },
      { filename: file },
    );
    if (registrations.size === size) throw new Error(`No Electron registrations in ${file}`);
  }
  return registrations;
}

export function selectSuiteFiles(files, { shard, patterns }) {
  if (shard === undefined && patterns.length === 0) return files;
  try {
    const { count, index } = parseShard(shard);
    if (count === 1 && patterns.length === 0) return files;
    const assignments = shardAssignments(count);
    if (count > 1 && assignments.size === 0) return files;
    // Node accepts both plain and /pattern/flags syntax. Stateful matching
    // depends on registration order, so let Node handle those filters alone.
    const matchers = patterns.map((pattern) => {
      const literal = /^\/(.*)\/([a-z]*)$/.exec(pattern);
      return new RegExp(literal?.[1] ?? pattern, literal?.[2]);
    });
    if (
      matchers.some(
        (matcher) => matcher.global || matcher.sticky || matcher.test("<root>") || matcher.test(""),
      )
    )
      return files;

    const registrations = discoverStaticRegistrations(files);
    if (count > 1) {
      if (registrations.some(({ ancestors, group }) => group || ancestors.length > 0)) return files;
      const names = new Set(registrations.map(({ name }) => name));
      if ([...assignments.keys()].some((name) => !names.has(name))) return files;
    }
    const selected = new Set();
    for (const { name, file, ancestors } of registrations) {
      if (count > 1) {
        const bucket = assignments.get(name);
        if (bucket === undefined) {
          if (hashBucket(name, count) === index) return files;
          continue;
        }
        if (bucket !== index) continue;
      }
      if (
        matchers.length === 0 ||
        matchers.some(
          (matcher) =>
            [name, ...ancestors].some((part) => matcher.test(part)) ||
            matcher.test([...ancestors, name].join(" ").trim()),
        )
      )
        selected.add(file);
    }
    return selected.size === 0 ? files : files.filter((file) => selected.has(file));
  } catch {
    // Preserve the actual worker's behavior and diagnostics if discovery fails.
    return files;
  }
}
