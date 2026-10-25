const assert = require("node:assert/strict");
const path = require("node:path");
const { promisify } = require("node:util");
const { execFileSync } = require("node:child_process");
const { appendFileSync, realpathSync, existsSync } = require("node:fs");
const { copyFile, mkdir, symlink, writeFile } = require("node:fs/promises");

function inside(directory, file) {
  const relative = path.relative(directory, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function assertFixtureAgent(file, directories) {
  if (
    !/^(claude|codex|agy|copilot|opencode|pi|gh|glab)(\.(exe|com|cmd))?$/i.test(path.basename(file))
  )
    return;
  // Match fs.promises.realpath used by native executable discovery, including
  // Windows 8.3 aliases. Compare canonical spellings on both sides of the guard.
  const resolved = realpathSync.native(file);
  assert.ok(
    directories.some((directory) => inside(realpathSync.native(directory), resolved)),
    `Agent outside test fixtures: ${file}`,
  );
}

// Install before loading main: even sub-second probes that process polling misses
// are refused and recorded. Production modules and the real CLI are untouched.
function guardAgentProbes(directories, log) {
  const children = require("node:child_process");
  const original = children.execFile;
  const originalSpawn = children.spawn;
  function check(file) {
    try {
      const executable =
        path.basename(file) === file
          ? (process.env.PATH ?? "")
              .split(path.delimiter)
              .flatMap((directory) =>
                (process.platform === "win32" && !path.extname(file)
                  ? [file, `${file}.exe`, `${file}.com`, `${file}.cmd`]
                  : [file]
                ).map((name) => path.join(directory, name)),
              )
              .find((candidate) => existsSync(candidate))
          : file;
      if (executable) assertFixtureAgent(executable, directories);
    } catch (error) {
      appendFileSync(log, `${error.message}\n`);
      throw error;
    }
  }
  children.spawn = function (file, ...args) {
    check(file);
    return originalSpawn.call(this, file, ...args);
  };
  children.execFile = function (file, ...args) {
    check(file);
    return original.call(this, file, ...args);
  };
  // Node's custom promisifier exposes promise.child (used by the git broker).
  children.execFile[promisify.custom] = function (file, ...args) {
    check(file);
    return original[promisify.custom].call(this, file, ...args);
  };
}

async function isolatedEnvironment(root, extraPath = "") {
  const bin = path.join(root, "bin");
  await mkdir(bin);
  // Expose just Node, never its installation directory (which may contain Codex).
  if (process.platform === "win32") await copyFile(process.execPath, path.join(bin, "node.exe"));
  else await symlink(process.execPath, path.join(bin, "node"));
  const system =
    process.platform === "win32"
      ? [
          process.env.SystemRoot,
          path.join(process.env.SystemRoot, "System32"),
          path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0"),
          // Git is installed outside Windows system folders. Resolve that one
          // required tool, never inherit the surrounding developer PATH.
          path.dirname(
            realpathSync(
              execFileSync(
                path.join(process.env.SystemRoot, "System32", "where.exe"),
                ["git.exe"],
                { encoding: "utf8" },
              )
                .trim()
                .split(/\r?\n/)[0],
            ),
          ),
        ]
      : ["/usr/bin", "/bin"];
  // Default fixtures must never reach host forge CLIs, including auth probes.
  for (const name of ["gh", "glab"]) {
    const executable = process.platform === "win32" ? `${name}.exe` : name;
    if (
      !extraPath
        .split(path.delimiter)
        .some(
          (directory) =>
            directory &&
            !system.includes(directory) &&
            existsSync(path.join(directory, executable)),
        )
    ) {
      if (process.platform === "win32")
        await copyFile(process.execPath, path.join(bin, executable));
      else await writeFile(path.join(bin, executable), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    }
  }
  // A system bin directory can contain real agent shims (for example VS Code's
  // /usr/bin/copilot). Expose only tools required by shell/Git/observer fixtures.
  const fixturePath = extraPath
    .split(path.delimiter)
    .filter((directory) => directory && !system.includes(directory));
  if (process.platform !== "win32") {
    for (const tool of [
      "bash",
      "sh",
      "git",
      "ps",
      "curl",
      "head",
      "cat",
      "mkdir",
      "rmdir",
      "rm",
      "sleep",
      "stty",
      "env",
      "groups",
      "seq",
      "less",
    ]) {
      if (fixturePath.some((directory) => existsSync(path.join(directory, tool)))) continue;
      const executable = system
        .map((directory) => path.join(directory, tool))
        .find((file) => existsSync(file));
      if (executable) await symlink(executable, path.join(bin, tool));
    }
  }
  const controlled = [
    ...new Set([bin, ...fixturePath, ...(process.platform === "win32" ? system : [])]),
  ].join(path.delimiter);
  const shell = path.join(root, "bash");
  if (process.platform !== "win32") {
    await writeFile(
      shell,
      `#!/bin/sh\nif [ "$1" = "-ilc" ]; then\n  export PATH=${shellQuote(controlled)}\n  exec /bin/bash --noprofile --norc -c "$2"\nfi\nif [ "$1" = "--rcfile" ]; then\n  { printf '%s\\n' '_foom_fixture_path=$PATH'; /bin/cat "$2"; printf '\\n%s\\n' 'export PATH=$_foom_fixture_path' 'unset _foom_fixture_path'; } > "$2.isolated"\n  rc="$2.isolated"\n  shift 2\n  exec /bin/bash --noprofile --rcfile "$rc" "$@"\nfi\nexec /bin/bash --noprofile "$@"\n`,
      { mode: 0o755 },
    );
  }
  return { PATH: controlled, ...(process.platform === "win32" ? {} : { SHELL: shell }) };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Packaged apps cannot use a bootstrap. Their account shell reads only these
// disposable HOME startup files, overriding system-profile PATH changes.
async function isolatedLoginProfiles(home, controlledPath) {
  const script = `export PATH=${shellQuote(controlledPath)}\n`;
  for (const name of [".bash_profile", ".profile", ".zshenv", ".zprofile", ".zshrc", ".zlogin"]) {
    await writeFile(path.join(home, name), script);
  }
}

module.exports = {
  assertFixtureAgent,
  guardAgentProbes,
  isolatedEnvironment,
  isolatedLoginProfiles,
};
