import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fingerprint } from "./validation-fingerprint.mjs";

// Memoize only a complete successful lint of identical inputs. Per-file ESLint
// caches cannot see type changes in a different file. Include installed packages
// as well as the lockfile so changed dependency declarations invalidate this too.
const cache = ".eslintcache";
const excluded = new Set([
  ".git",
  cache,
  "build",
  "out",
  "coverage",
  "inspiration",
  "spikes",
  "test-results",
  "playwright-report",
]);
const inputs = () =>
  fingerprint(
    readdirSync(".").filter((name) => !excluded.has(name)),
    new Set(["docs/mockups", ".husky/_"]),
  );
if (process.argv.length > 2)
  throw new Error("lint:local does not accept arguments; use lint or lint:fix");
const before = inputs();
let saved;
try {
  saved = JSON.parse(readFileSync(cache, "utf8"));
} catch {
  /* A missing/corrupt cache is a miss. */
}
if (saved?.fingerprint === before) {
  console.info("Local lint: identical inputs to the last successful complete lint.");
} else {
  rmSync(cache, { force: true });
  const result = spawnSync(
    process.execPath,
    ["node_modules/eslint/bin/eslint.js", ".", "--max-warnings=0"],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (result.status === 0 && inputs() === before)
    writeFileSync(cache, JSON.stringify({ fingerprint: before }));
}
