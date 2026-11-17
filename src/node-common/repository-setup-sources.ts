import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { setupSourcePath } from "../shared/repository-setup";
import type { SetupSources } from "../shared/repository-setup.d";

/** Exact membership is policy; additions require review of existing baselines. */
export const setupSourceNames = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain",
  "rust-toolchain.toml",
  "go.mod",
  "go.sum",
  "go.work",
  "go.work.sum",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  ".python-version",
  "Gemfile",
  "Gemfile.lock",
  ".ruby-version",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gradle.properties",
  "global.json",
  "Directory.Build.props",
  "Directory.Packages.props",
  "composer.json",
  "composer.lock",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  "mise.toml",
  ".mise.toml",
  "Makefile",
  "CMakeLists.txt",
  "CMakePresets.json",
  "meson.build",
  "meson_options.txt",
  "Dockerfile",
  "Containerfile",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
]);
const excludedDirectories = new Set([
  ".git",
  "node_modules",
  ".venv",
  "vendor",
  "target",
  "dist",
  "build",
  "out",
  "coverage",
  "test-results",
  "inspiration",
  "docs/mockups",
]);
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

/** Regular-file data only; no Git, interpreter, configuration loader or checkout commands. */
export async function inspectSetupSources(
  checkout: string,
  evidence: readonly string[],
): Promise<SetupSources> {
  if (evidence.length > 64 || !evidence.every(setupSourcePath))
    throw new Error("Unable to verify sources");
  const root = await realpath(checkout);
  if (!(await lstat(checkout)).isDirectory()) throw new Error("Unable to verify sources");
  const wanted = new Set(evidence);
  let entries = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error("Unable to verify sources");
    for await (const entry of await opendir(directory)) {
      if (++entries > 20000) throw new Error("Unable to verify sources");
      const path = relative(root, join(directory, entry.name)).split(sep).join("/");
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name) && !excludedDirectories.has(path))
          await walk(join(directory, entry.name), depth + 1);
      } else if (
        setupSourceNames.has(entry.name) ||
        /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path) ||
        /\.(?:csproj|fsproj|vcxproj)$/u.test(entry.name)
      ) {
        wanted.add(path);
        if (wanted.size > 64) throw new Error("Unable to verify sources");
      } else if (entry.isSymbolicLink()) {
        // A directory link could hide matching workspace manifests. Never traverse it.
        throw new Error("Unable to verify sources");
      }
    }
  };
  await walk(root, 0);
  let total = 0;
  const files: { path: string; digest: string }[] = [];
  for (const path of [...wanted].sort()) {
    if (!setupSourcePath(path)) throw new Error("Unable to verify sources");
    let parent = root;
    for (const part of path.split("/").slice(0, -1)) {
      parent = join(parent, part);
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unable to verify sources");
    }
    const target = join(root, path);
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 1048576)
      throw new Error("Unable to verify sources");
    const handle = await open(
      target,
      constants.O_RDONLY |
        constants.O_NONBLOCK |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
        throw new Error("Unable to verify sources");
      const buffer = Buffer.alloc(1048577);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      total += bytesRead;
      const after = await lstat(target);
      if (
        bytesRead > 1048576 ||
        total > 4194304 ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== bytesRead ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        (await realpath(target)) !== target
      )
        throw new Error("Unable to verify sources");
      files.push({ path, digest: sha(buffer.subarray(0, bytesRead)) });
    } finally {
      await handle.close();
    }
  }
  return { fingerprint: sha(JSON.stringify(files)), files };
}
