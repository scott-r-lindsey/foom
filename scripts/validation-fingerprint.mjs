import { createHash } from "node:crypto";
import {
  accessSync,
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
export const systemCodesign = process.platform === "darwin" ? "/usr/bin/codesign" : undefined;

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

export function buildFileDigest(path, { optional = false, before = Infinity, expected } = {}) {
  const stat = regularPath(path, optional);
  if (!stat) return null;
  if (stat.ctimeMs >= before) throw new BuildInputChanged(`Changed bundle input: ${path}`);
  const bytes = readRegularFile(path, stat, false);
  if (expected && !bytes.equals(expected))
    throw new BuildInputChanged(`Changed build input: ${path}`);
  return createHash("sha256")
    .update(JSON.stringify([stat.mode, stat.size]))
    .update(bytes)
    .digest("hex");
}

export function buildPathKind(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (realpathSync(path) !== path || (!stat.isFile() && !stat.isDirectory()))
    throw new Error(`Unsupported fingerprint path: ${path}`);
  return stat.isDirectory() ? "directory" : "file";
}

export function isCheckoutBuildPath(path) {
  const root = process.cwd();
  return path !== root && path.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function dependencyDirectoryDigest(path) {
  const kind = buildPathKind(path);
  if (kind === null) return null;
  return buildDirectoryDigest(path);
}

// Search permission and file kind both affect execvp's choice on POSIX.
export function isExecutableFile(path) {
  try {
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) return false;
    throw error;
  }
}

export function buildDirectoryDigest(path, { expectedNames } = {}) {
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
  const entries = listDirectory(path, { withFileTypes: true }).filter(
    (entry) => !generated.has(entry.name),
  );
  if (
    expectedNames &&
    JSON.stringify(entries.map(({ name }) => name).sort()) !== JSON.stringify(expectedNames)
  )
    throw new BuildInputChanged(`Changed build input directory: ${path}`);
  const names = entries
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
  const installState = ["node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml"].map((path) =>
    buildFileDigest(resolve(path), { optional: true }),
  );
  if (installState.every((hash) => hash === null)) throw new Error("Missing pnpm install state");
  return createHash("sha256")
    .update(JSON.stringify([process.execPath, process.env.PATH, process.env.NODE_PATH]))
    .update(JSON.stringify(installState))
    .update(
      fingerprint(["scripts", "package.json", "pnpm-lock.yaml", ".npmrc"], {
        followSymlinks: false,
      }),
    )
    .update(buildFileDigest(process.execPath))
    .update(buildFileDigest(nodeRuntimeLicense()))
    .update(systemCodesign ? buildFileDigest(systemCodesign) : "")
    .digest("hex");
}

export function matchesBuildInputs(snapshot) {
  return [
    [snapshot.inputs, buildFileDigest, isCheckoutBuildPath],
    [snapshot.dependencyDirectories, dependencyDirectoryDigest, isCheckoutBuildPath],
    [snapshot.directories, buildDirectoryDigest],
    [snapshot.lookups, buildPathKind],
    [snapshot.executables, isExecutableFile],
    [snapshot.manifests, (path) => buildFileDigest(path, { optional: true })],
  ].every(
    ([entries, digest, inScope = () => true]) =>
      Array.isArray(entries) &&
      entries.every(
        ([path, hash]) =>
          typeof path === "string" && isAbsolute(path) && inScope(path) && digest(path) === hash,
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
