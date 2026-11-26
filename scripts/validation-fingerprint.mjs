import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, join, relative, resolve, sep } from "node:path";
import { nodeRuntimeLicense } from "./node-runtime.mjs";

const buildDirectories = new Set(["src", "scripts", "node_modules"]);

function readRegularFile(path, stat, followSymlinks) {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY;
  const fd = openSync(path, followSymlinks ? flags : flags | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw new Error(`Changed fingerprint input: ${path}`);
    return readFileSync(fd);
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

function compilerInputs() {
  const configs = readdirSync(".").filter((name) => /^tsconfig.*\.json$/.test(name));
  if (configs.length === 0) return [];
  const ts = createRequire(import.meta.url)("typescript");
  const files = new Set();
  const readInput = (path) => {
    const text = ts.sys.readFile(path);
    if (text !== undefined) files.add(path);
    return text;
  };
  const host = {
    ...ts.sys,
    readFile: readInput,
    onUnRecoverableConfigFileDiagnostic() {},
  };
  for (const config of configs) {
    // Only the configs passed to tsc by build.mjs need a compiler source graph.
    const compiled = config === "tsconfig.main.json" || config === "tsconfig.renderer.json";
    const parsed = ts.getParsedCommandLineOfConfigFile(
      resolve(config),
      {},
      compiled ? host : { ...host, readDirectory: () => [] },
    );
    // Configs parsed only for their inheritance can report no input files.
    if (!parsed || parsed.errors.some(({ code }) => code !== 18003)) return undefined;
    if (!compiled) continue;
    const compiler = ts.createCompilerHost(parsed.options);
    compiler.readFile = (path) => {
      const [directory, entry] = relative(process.cwd(), path).split(sep);
      if (buildDirectories.has(directory) && entry !== ".vite" && entry !== ".vite-temp")
        return ts.sys.readFile(path);
      return readInput(path);
    };
    // Resolve the same imports, type roots and references as tsc without checking or emitting.
    ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
      projectReferences: parsed.projectReferences,
      host: compiler,
    });
  }
  return files;
}

export function buildFingerprint() {
  const files = compilerInputs();
  if (!files) return undefined;
  return fingerprint([
    // The SEA builders copy the selected Node executable and notice into the build.
    process.execPath,
    nodeRuntimeLicense(),
    ...buildDirectories,
    "package.json",
    "pnpm-lock.yaml",
    ".npmrc",
    ...files,
  ]);
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
      const info = darwin ? lstatSync(original) : statSync(original);
      const mode = path === `${nativeDir}/spawn-helper` ? 0o700 : 0o600;
      if (
        !bytes ||
        stat.uid !== process.getuid() ||
        (stat.mode & 0o777) !== mode ||
        !info.isFile() ||
        !bytes.equals(readRegularFile(original, info, !darwin))
      )
        throw new Error(`Unsafe fixture asset: ${path}`);
      return true;
    },
  });
}
