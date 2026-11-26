// Preloaded only for a reusable Electron build, including its Node subprocesses.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import fsp from "node:fs/promises";
import childProcess from "node:child_process";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { dirname, delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BuildInputChanged,
  buildDirectoryDigest,
  buildFileDigest,
  buildPathKind,
  dependencyDirectoryDigest,
  isCheckoutBuildPath,
  isExecutableFile,
  systemCodesign,
} from "./validation-fingerprint.mjs";
import { nodeRuntimeLicense } from "./node-runtime.mjs";

const staging = process.env.FOOM_BUILD_INPUTS;
const root = process.cwd();
const generated = join(root, "build");
const inputs = new Map();
const directories = new Map();
const dependencyDirectories = new Map();
const manifests = new Map();
const lookups = new Map();
const executables = new Map();
const untracked = new AsyncLocalStorage();
const parsedConfigs = new Set();
const require = createRequire(import.meta.url);
const { lstatSync, readFileSync, readdirSync, writeFileSync, statSync } = fs;
let valid = true;
let changed = false;

export function withoutBuildInputTracking(action) {
  return staging ? untracked.run(true, action) : action();
}

function inputPath(value) {
  if (untracked.getStore()) return;
  if (typeof value !== "string" && !(value instanceof URL && value.protocol === "file:")) return;
  const path = resolve(value instanceof URL ? fileURLToPath(value) : value);
  if (path !== generated && !path.startsWith(generated + sep)) return path;
}

function capture(path, digest, entries) {
  try {
    const hash = digest(path);
    if (entries.has(path) && entries.get(path) !== hash) changed = true;
    entries.set(path, hash);
  } catch (error) {
    if (error instanceof BuildInputChanged) changed = true;
    else valid = false;
  }
}

function recordDependencyDirectories(file) {
  // Capture node_modules on the lookup chain, including locations that are absent.
  // The installed tree's identity otherwise comes from pnpm's install state.
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules");
    if (!dependencyDirectories.has(candidate))
      capture(candidate, dependencyDirectoryDigest, dependencyDirectories);
    if (dir === root) break;
  }
}

function recordFile(path, options, entries) {
  if (!isCheckoutBuildPath(path)) {
    try {
      if (options.optional && !lstatSync(path, { throwIfNoEntry: false })) entries.set(path, null);
      else valid = false;
    } catch {
      valid = false;
    }
    return;
  }
  capture(path, (file) => buildFileDigest(file, options), entries);
  if (entries.get(path)) recordDependencyDirectories(path);
}

export function recordBuildInput(value, expected) {
  if (!staging) return;
  const path = inputPath(value);
  if (path && (expected || !inputs.has(path))) recordFile(path, { expected }, inputs);
}

export function recordBuildDirectory(value, expectedNames) {
  if (!staging) return;
  const path = inputPath(value);
  if (path && (expectedNames || !directories.has(path))) {
    if (path === root || isCheckoutBuildPath(path))
      capture(path, (directory) => buildDirectoryDigest(directory, { expectedNames }), directories);
    else valid = false;
  }
}

function recordLookup(path) {
  if (!lookups.has(path)) capture(path, buildPathKind, lookups);
  return lookups.get(path);
}

function recordManifest(file, started) {
  if (!manifests.has(file)) recordFile(file, { optional: true, before: started }, manifests);
}

function recordModuleContext(path, started) {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    recordBuildDirectory(dir);
    recordManifest(join(dir, "package.json"), started);

    if (dir === root || !dir.startsWith(root + sep)) break;
  }
}

function recordCandidate(path, started, unresolved = false) {
  if (!inputPath(path)) return;
  const recordDirectory = (directory) => {
    // A new resolution candidate may have appeared after esbuild tried the import.
    if (unresolved && lstatSync(directory, { throwIfNoEntry: false })?.ctimeMs >= started)
      changed = true;
    recordBuildDirectory(directory);
  };
  if (recordLookup(dirname(path)) === "directory") recordDirectory(dirname(path));
  if (recordLookup(path) === "directory") {
    recordDirectory(path);
    recordManifest(join(path, "package.json"), started);
  }
}

function recordPackageCandidates(importer, specifier, started) {
  const packageName = /^(?:@[^/#:]+\/)?[^/#:]+/.exec(specifier)?.[0];
  if (!packageName) return;
  for (let dir = dirname(importer); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", packageName);
    if (recordLookup(candidate) === "directory") recordCandidate(candidate, started);
    if (dir === dirname(dir)) break;
  }
}

function recordConfig(path, started) {
  recordManifest(path, started);
  if (!manifests.get(path) || parsedConfigs.has(path))
    return manifests.has(path) && manifests.get(path) !== null;
  parsedConfigs.add(path);
  // esbuild's metafile omits its own tsconfig inheritance. Read the config
  // with TypeScript's parser so the filesystem hooks capture its bases.
  try {
    const ts = require("typescript");
    const config = ts.getParsedCommandLineOfConfigFile(
      path,
      {},
      {
        ...ts.sys,
        readDirectory: () => [],
        onUnRecoverableConfigFileDiagnostic() {
          valid = false;
        },
      },
    );
    // A newly created alias target can take precedence over a metafile input.
    // The metafile does not expose the paths that esbuild tried and skipped.
    if (
      !config ||
      config.options.paths ||
      config.options.baseUrl ||
      config.errors.some(({ code }) => code !== 18002 && code !== 18003)
    )
      valid = false;
  } catch {
    valid = false;
  }
  return true;
}

export function recordBundleInputs(metafile, started, tsconfig) {
  if (!staging) return;
  if (tsconfig) recordConfig(resolve(tsconfig), started);
  for (const [name, { imports }] of Object.entries(metafile.inputs)) {
    const path = resolve(name);
    recordFile(path, { before: started }, inputs);
    if (!isCheckoutBuildPath(path)) continue;
    // Metafiles identify loaded files. Track nearby manifests and resolution
    // candidates as well, so a newly added entry can invalidate a previous match.
    recordModuleContext(path, started);
    if (!tsconfig && !path.split(sep).includes("node_modules")) {
      for (let dir = dirname(path); ; dir = dirname(dir)) {
        if (recordConfig(join(dir, "tsconfig.json"), started) || dir === dirname(dir)) break;
      }
    }
    for (const { original, external, kind, path: imported } of imports) {
      if (external) {
        // esbuild leaves unresolved optional imports external and omits "original".
        if (/^\.{1,2}(?:[/\\]|$)/.test(imported) || isAbsolute(imported))
          recordCandidate(resolve(dirname(path), imported), started, true);
        continue;
      }
      if (!original) continue;
      if (original.startsWith(".") || isAbsolute(original)) {
        recordCandidate(resolve(dirname(path), original), started);
      } else {
        recordPackageCandidates(path, original, started);
        if (kind === "import-rule" || kind === "url-token" || kind === "composes-from")
          recordCandidate(resolve(dirname(path), original), started);
      }
    }
  }
}

function trackRead(original, { optional = false, runtimeCopy = false } = {}) {
  return function (path, ...args) {
    const file = inputPath(path);
    try {
      // The selected Node executable and license are verified by the runner
      // before and after preparation as part of the build environment.
      const runtime = runtimeCopy && (file === process.execPath || file === nodeRuntimeLicense());
      if (file && !runtime && (!optional || lstatSync(file, { throwIfNoEntry: false })))
        recordBuildInput(file);
    } catch {
      valid = false;
    }
    return original(path, ...args);
  };
}

function trackCopyTree(original) {
  return function (path, target, options) {
    return original(path, target, {
      ...options,
      filter(source, destination) {
        const included = options?.filter?.(source, destination) ?? true;
        // The build's copy filters are synchronous. Promise-returning filters
        // are still conservatively tracked before the copy.
        if (included) {
          try {
            if (statSync(source).isDirectory()) recordBuildDirectory(source);
            else recordBuildInput(source);
          } catch {
            valid = false;
          }
        }
        return included;
      },
    });
  };
}

function recordCommandInput(path) {
  // The runner fingerprints the system signer before and after the build.
  if (path !== systemCodesign) recordBuildInput(path);
}

function trackCommand(original) {
  return function (command, ...args) {
    // The runner checks the Git revision and selected Node executable separately.
    if (command === "git" || command === process.execPath) return original(command, ...args);
    try {
      const options = Array.isArray(args[0]) ? args[1] : args[0];
      const cwd = options?.cwd instanceof URL ? fileURLToPath(options.cwd) : (options?.cwd ?? root);
      if (!options?.shell && (isAbsolute(command) || command.includes("/"))) {
        recordCommandInput(resolve(cwd, command));
      } else if (!options?.shell && process.platform !== "win32") {
        const path = (options?.env ?? process.env).PATH;
        if (path === undefined) valid = false;
        else {
          const selected = path.split(delimiter).find((dir) => {
            const candidate = resolve(cwd, dir, command);
            capture(candidate, isExecutableFile, executables);
            return executables.get(candidate) === true;
          });
          if (selected === undefined) valid = false;
          else recordCommandInput(resolve(cwd, selected, command));
        }
      } else {
        // Shell and Windows command searches have different resolution rules.
        valid = false;
      }
    } catch {
      valid = false;
    }
    return original(command, ...args);
  };
}

if (staging) {
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith("file:")) {
        const path = inputPath(new URL(url));
        if (path && !inputs.has(path)) {
          recordBuildInput(path);
          if (isCheckoutBuildPath(path)) recordModuleContext(path);
        }
      }
      return nextLoad(url, context);
    },
  });
  // tsc's CLI uses the system host's synchronous reads for its program,
  // package metadata and the full config inheritance chain.
  fs.readFileSync = trackRead(readFileSync, { optional: true });
  fs.readdirSync = function (value, ...args) {
    const path = inputPath(value);
    if (path && recordLookup(path) === "directory") recordBuildDirectory(path);
    return readdirSync(value, ...args);
  };
  // TypeScript probes potential module and type locations before reading them.
  // Record those results so a new module cannot shadow a previously loaded one.
  if (/[/\\]_?tsc(?:\.js)?$/.test(process.argv[1] ?? "")) {
    fs.statSync = function (value, ...args) {
      const path = inputPath(value);
      if (path) recordLookup(path);
      return statSync(value, ...args);
    };
  }
  fs.copyFileSync = trackRead(fs.copyFileSync, { runtimeCopy: true });
  fs.cpSync = trackCopyTree(fs.cpSync);
  const readdir = fsp.readdir;
  fsp.readdir = async function (path, ...args) {
    const result = await readdir(path, ...args);
    recordBuildDirectory(path);
    return result;
  };
  fsp.readFile = trackRead(fsp.readFile, { optional: true });
  fsp.copyFile = trackRead(fsp.copyFile, { runtimeCopy: true });
  fsp.cp = trackCopyTree(fsp.cp);
  childProcess.spawn = trackCommand(childProcess.spawn);
  childProcess.spawnSync = trackCommand(childProcess.spawnSync);
  childProcess.execFileSync = trackCommand(childProcess.execFileSync);
  syncBuiltinESMExports();
  process.on("exit", () => {
    try {
      writeFileSync(
        join(staging, `${process.pid}.json`),
        JSON.stringify({
          valid,
          changed,
          inputs: [...inputs],
          directories: [...directories],
          dependencyDirectories: [...dependencyDirectories],
          manifests: [...manifests],
          lookups: [...lookups],
          executables: [...executables],
        }),
      );
    } catch {
      // Missing evidence makes the build ineligible for reuse.
    }
  });
}
