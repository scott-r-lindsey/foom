import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { nodeRuntimeLicense } from "./node-runtime.mjs";

const listDirectory = readdirSync;

export class BuildInputChanged extends Error {}

function readRegularFile(path, stat, followSymlinks) {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY;
  const fd = openSync(path, followSymlinks ? flags : flags | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw new BuildInputChanged(`Changed fingerprint input: ${path}`);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (after.ctimeMs !== opened.ctimeMs || after.size !== bytes.length)
      throw new BuildInputChanged(`Changed fingerprint input: ${path}`);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

// Hash bytes, names and modes, including installed dependencies and declarations.
// A lockfile alone cannot detect local edits to installed packages.
export function fingerprint(
  paths,
  { ignored = new Set(), followSymlinks = true, omit = () => false } = {},
) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([process.version, process.platform, process.arch]));
  function visit(path, ancestors = new Set()) {
    const normalized = path.split(sep).join("/");
    // Vitest writes timing/results and temporary config bundles here. These are
    // generated output, not installed package code or declarations.
    if (
      normalized === "node_modules/.vite" ||
      normalized === "node_modules/.vite-temp" ||
      ignored.has(normalized)
    )
      return;
    const stat = followSymlinks ? statSync(path) : lstatSync(path);
    const directory = stat.isDirectory();
    if (!directory && !stat.isFile()) throw new Error(`Unsupported file type: ${path}`);
    const bytes = directory ? undefined : readRegularFile(path, stat, followSymlinks);
    if (!omit(normalized, stat, bytes)) {
      hash.update(JSON.stringify([path, stat.mode, bytes?.length]));
      if (bytes) hash.update(bytes);
    }
    if (directory) {
      const real = followSymlinks ? realpathSync(path) : path;
      if (ancestors.has(real)) throw new Error(`Circular input: ${path}`);
      const next = new Set([...ancestors, real]);
      for (const name of readdirSync(path).sort()) visit(join(path, name), next);
    }
  }
  for (const path of [...paths].sort()) visit(path);
  return hash.digest("hex");
}

function regularPath(path, optional = false) {
  const stat = lstatSync(path, { throwIfNoEntry: !optional });
  if (!stat) return;
  if (!stat.isFile() || realpathSync(path) !== path)
    throw new Error(`Unsupported fingerprint input: ${path}`);
  return stat;
}

export function readBuildFile(path) {
  const absolute = resolve(path);
  return readRegularFile(absolute, regularPath(absolute), false);
}

export function buildFileDigest(path, { optional = false, before = Infinity } = {}) {
  const stat = regularPath(path, optional);
  if (!stat) return null;
  if (stat.ctimeMs >= before) throw new BuildInputChanged(`Changed bundle input: ${path}`);
  return createHash("sha256")
    .update(JSON.stringify([stat.mode, stat.size]))
    .update(readRegularFile(path, stat, false))
    .digest("hex");
}

export function buildPathKind(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (realpathSync(path) !== path || (!stat.isFile() && !stat.isDirectory()))
    throw new Error(`Unsupported fingerprint path: ${path}`);
  return stat.isDirectory() ? "directory" : "file";
}

export function buildDirectoryDigest(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || realpathSync(path) !== path)
    throw new Error(`Unsupported fingerprint directory: ${path}`);
  // Generated products can come and go without changing module resolution.
  const generated =
    path === process.cwd()
      ? new Set(["build", "out", "coverage", "test-results", ".oxlintcache", ".cache"])
      : path === resolve("node_modules")
        ? new Set([".vite", ".vite-temp"])
        : new Set();
  const names = listDirectory(path, { withFileTypes: true })
    .filter((entry) => !generated.has(entry.name))
    .map((entry) => [
      entry.name,
      entry.isFile(),
      entry.isDirectory(),
      entry.isSymbolicLink() ? readlinkSync(join(path, entry.name)) : null,
    ])
    .sort();
  return createHash("sha256").update(JSON.stringify(names)).digest("hex");
}

export function buildEnvironmentFingerprint() {
  return createHash("sha256")
    .update(JSON.stringify([process.execPath, process.env.PATH, process.env.NODE_PATH]))
    .update(
      fingerprint(["scripts", "package.json", "pnpm-lock.yaml", ".npmrc"], {
        followSymlinks: false,
      }),
    )
    .update(buildFileDigest(process.execPath))
    .update(buildFileDigest(nodeRuntimeLicense()))
    .digest("hex");
}

export function matchesBuildInputs(snapshot) {
  return [
    [snapshot.inputs, buildFileDigest],
    [snapshot.directories, buildDirectoryDigest],
    [snapshot.lookups, buildPathKind],
    [snapshot.manifests, (path) => buildFileDigest(path, { optional: true })],
  ].every(
    ([entries, digest]) =>
      Array.isArray(entries) &&
      entries.every(
        ([path, hash]) => typeof path === "string" && isAbsolute(path) && digest(path) === hash,
      ),
  );
}

export function buildOutputFingerprint() {
  const nativeDir = "build/remote-host/native";
  return fingerprint(["build"], {
    followSymlinks: false,
    omit(path, stat, bytes) {
      if (process.platform === "win32") return false;
      if (path === nativeDir) {
        if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700)
          throw new Error(`Unsafe fixture directory: ${path}`);
        return true;
      }
      const darwin = process.platform === "darwin";
      if (path !== `${nativeDir}/pty.node` && !(darwin && path === `${nativeDir}/spawn-helper`))
        return false;
      // The SEA extracts these copies at runtime. The embedded bytes already
      // contribute to the receipt. Check any extracted copy against its source.
      const source = darwin
        ? "build/remote-sea"
        : `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}`;
      if (darwin && !lstatSync(source).isDirectory())
        throw new Error(`Unsafe fixture asset directory: ${source}`);
      const original = join(source, basename(path));
      const info = regularPath(resolve(original));
      const mode = path === `${nativeDir}/spawn-helper` ? 0o700 : 0o600;
      if (
        !bytes ||
        stat.uid !== process.getuid() ||
        (stat.mode & 0o777) !== mode ||
        !info.isFile() ||
        !bytes.equals(readRegularFile(original, info, false))
      )
        throw new Error(`Unsafe fixture asset: ${path}`);
      return true;
    },
  });
}
