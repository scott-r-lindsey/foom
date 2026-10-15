import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

// Hash bytes, names and modes, including installed dependencies and declarations.
// A lockfile alone cannot detect local edits to installed packages.
export function fingerprint(paths, ignored = new Set()) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([process.version, process.platform, process.arch]));
  function visit(path, ancestors = new Set()) {
    const normalized = path.replaceAll("\\", "/");
    // Vitest writes timing/results and temporary config bundles here. These are
    // generated output, not installed package code or declarations.
    if (
      normalized === "node_modules/.vite" ||
      normalized === "node_modules/.vite-temp" ||
      ignored.has(normalized)
    )
      return;
    const real = realpathSync(path);
    if (ancestors.has(real)) throw new Error(`Circular input: ${path}`);
    const stat = statSync(path);
    hash.update(JSON.stringify([path, stat.mode]));
    if (stat.isDirectory()) {
      const next = new Set([...ancestors, real]);
      for (const name of readdirSync(path).sort()) visit(join(path, name), next);
    } else {
      hash.update(readFileSync(path));
    }
  }
  for (const path of [...paths].sort()) visit(path);
  return hash.digest("hex");
}

export function buildFingerprint() {
  return fingerprint([
    "src",
    "scripts",
    "node_modules",
    "package.json",
    "pnpm-lock.yaml",
    ".npmrc",
    ...readdirSync(".").filter((name) => /^tsconfig.*\.json$/.test(name)),
  ]);
}
