import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { suiteFiles } from "../tests/electron/test-suites.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function decode(value) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return value.replace(/&(?:#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);|&/gi, (entity) => {
    if (entity === "&") throw new Error("Invalid XML entity");
    const name = entity.slice(1, -1);
    if (Object.hasOwn(entities, name)) return entities[name];
    const point = name.startsWith("#x")
      ? Number.parseInt(name.slice(2), 16)
      : Number(name.slice(1));
    if (
      !(
        point === 9 ||
        point === 10 ||
        point === 13 ||
        (point >= 32 && point <= 0xd7ff) ||
        (point >= 0xe000 && point <= 0xfffd) ||
        (point >= 0x10000 && point <= 0x10ffff)
      )
    )
      throw new Error("Invalid XML character");
    return String.fromCodePoint(point);
  });
}

// A deliberately narrow reader for Node's JUnit XML: quoted attributes, nested
// elements, comments and CDATA. No DTDs, external entities or network access.
export function parseCases(xml) {
  const tokens =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[\w:.-]+(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>/g;
  const stack = [];
  const cases = [];
  let current;
  let end = 0;
  for (const match of xml.matchAll(tokens)) {
    const text = xml.slice(end, match.index);
    if (text.includes("<")) throw new Error("Unsupported or malformed JUnit XML");
    decode(text);
    end = match.index + match[0].length;
    const token = match[0];
    if (token.startsWith("<!") || token.startsWith("<?")) continue;
    const tag = /^<\/?([\w:.-]+)/.exec(token)[1];
    if (token.startsWith("</")) {
      if (stack.pop() !== tag) throw new Error("Mismatched JUnit XML tags");
      if (tag === "testcase") current = undefined;
      continue;
    }
    const attrs = Object.fromEntries(
      [...token.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(
        ([, key, double, single]) => [key, decode(double ?? single)],
      ),
    );
    if (tag === "testcase") {
      if (current) throw new Error("Nested JUnit testcase");
      current = { ...attrs, skipped: false, failed: false };
      cases.push(current);
    } else if (current) {
      if (tag === "skipped") current.skipped = true;
      if (tag === "failure" || tag === "error") current.failed = true;
    }
    if (!token.endsWith("/>")) stack.push(tag);
    else if (tag === "testcase") current = undefined;
  }
  if (stack.length || xml.slice(end).trim()) throw new Error("Incomplete JUnit XML");
  return cases;
}

export function readMeasurements(sources, platforms, names, count) {
  const durations = new Map(names.map((name) => [name, platforms.map(() => undefined)]));
  for (const source of sources) {
    if (!/^\d+$/.test(basename(source)))
      throw new Error(`Source must be a numeric Actions run ID: ${source}`);
    for (const [index, platform] of platforms.entries()) {
      const reports = readdirSync(source)
        .filter((name) => name.startsWith(`electron-results-${platform}-`))
        .sort();
      if (reports.length !== count)
        throw new Error(
          `Expected ${count} ${platform} reports in ${source}, got ${reports.length}`,
        );
      const seen = new Set();
      for (const report of reports) {
        for (const entry of parseCases(
          readFileSync(resolve(source, report, "electron.xml"), "utf8"),
        )) {
          if (!entry.file?.replaceAll("\\", "/").endsWith("/test-shard.js")) continue;
          const { name } = entry;
          if (!name || seen.has(name))
            throw new Error(`Missing or duplicate case ${name} in ${source} (${platform})`);
          seen.add(name);
          const seconds = Number(entry.time);
          if (
            !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(entry.time ?? "") ||
            !Number.isFinite(seconds) ||
            seconds < 0
          )
            throw new Error(`Invalid duration for ${name}`);
          if (entry.failed) throw new Error(`Failed case ${name}; use passing reports`);
          const values = durations.get(name);
          if (values)
            values[index] = Math.max(
              values[index] ?? 0,
              entry.skipped ? 0 : Math.round(seconds * 1000) / 1000,
            );
        }
      }
    }
  }
  for (const [name, values] of durations) {
    if (values.some((value) => value === undefined))
      throw new Error(`Current case missing measurements: ${name}`);
  }
  return durations;
}

export function balance(durations, count) {
  const width = durations.values().next().value?.length ?? 0;
  const totals = Array.from({ length: width }, (_, p) =>
    [...durations.values()].reduce((sum, values) => sum + values[p], 0),
  );
  if (!width || totals.some((total) => total <= 0))
    throw new Error("Every platform needs a positive measured total");
  const fractions = new Map(
    [...durations].map(([name, values]) => [name, values.map((value, p) => value / totals[p])]),
  );
  const loads = Array.from({ length: count }, () => totals.map(() => 0));
  const shards = Array.from({ length: count }, () => []);
  const names = [...durations.keys()].sort(
    (a, b) => Math.max(...fractions.get(b)) - Math.max(...fractions.get(a)) || compare(a, b),
  );
  for (const name of names) {
    const weights = fractions.get(name);
    const scores = loads.map((_, index) => {
      const projected = loads.map((load, shard) =>
        load.map((value, p) => value + (shard === index ? weights[p] : 0)),
      );
      return [
        Math.max(...projected.flat()),
        projected[index].reduce((sum, value) => sum + value, 0),
        index,
      ];
    });
    scores.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const selected = scores[0][2];
    shards[selected].push([name, durations.get(name)]);
    loads[selected] = loads[selected].map((value, p) => value + weights[p]);
  }
  return shards.map((shard) => Object.fromEntries(shard.sort(([a], [b]) => compare(a, b))));
}

function projectedTotals(shards, durations, width) {
  const assignments = new Map(
    shards.flatMap((shard, i) => Object.keys(shard).map((name) => [name, i])),
  );
  const loads = shards.map(() => Array(width).fill(0));
  for (const [name, values] of durations) {
    const index =
      assignments.get(name) ??
      createHash("sha256").update(name).digest().readUInt32BE(0) % shards.length;
    values.forEach((value, p) => {
      loads[index][p] += value;
    });
  }
  return Array.from({ length: width }, (_, p) =>
    loads.map((load) => (Math.round(load[p] * 10) / 10).toFixed(1)),
  );
}

export function writePlan(path, plan) {
  // Preserve repository formatting byte-for-byte when regeneration is a no-op.
  if (JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) !== JSON.stringify(plan)) {
    writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`);
  }
}

function main(args) {
  const sources = [
    ...new Set(args.filter((arg) => arg !== "--write").map((arg) => resolve(arg))),
  ].sort();
  if (!sources.length || sources.some((source) => basename(source).startsWith("--"))) {
    throw new Error("Usage: node scripts/rebalance-electron-shards.mjs RUN_DIR... [--write]");
  }
  const planPath = resolve(root, "tests/electron/shard-plan.json");
  const old = JSON.parse(readFileSync(planPath, "utf8"));
  const names = [];
  for (const file of suiteFiles()) {
    const suiteRequire = createRequire(file);
    runInNewContext(readFileSync(file, "utf8"), {
      process,
      require: (specifier) =>
        specifier === "./test-shard.js"
          ? { test: (name) => names.push(name) }
          : suiteRequire(specifier),
    });
  }
  if (new Set(names).size !== names.length) throw new Error("Duplicate current test registration");
  const durations = readMeasurements(sources, old.platforms, names, old.shards.length);
  const shards = balance(durations, old.shards.length);
  console.info(
    `${names.length} current cases; per-platform maxima across ${sources.length} runs (seconds)`,
  );
  for (const [label, assignments] of [
    ["Before (including hash fallback)", old.shards],
    ["After", shards],
  ]) {
    console.info(label);
    projectedTotals(assignments, durations, old.platforms.length).forEach((totals, p) =>
      console.info(`  ${old.platforms[p]}: ${totals.join(" / ")}`),
    );
  }
  if (args.includes("--write")) {
    writePlan(planPath, {
      sourceRuns: sources.map((source) => Number(basename(source))),
      platforms: old.platforms,
      shards,
    });
    console.info("Regenerated tests/electron/shard-plan.json; run pnpm run format if changed");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
