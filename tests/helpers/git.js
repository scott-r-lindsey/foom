const childProcess = require("node:child_process");
const { promisify } = require("node:util");
// Reflog writes also need an identity. Without one Git can resolve the host's
// name, making even local branch and worktree operations depend on DNS.
const identity = {
  GIT_AUTHOR_NAME: "Foom Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Foom Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

/** @param {NodeJS.ProcessEnv} [source] */
function gitEnvironment(source = process.env) {
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
    ),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ...identity,
  };
}

/** @param {string[]} args @param {import("node:child_process").ExecFileSyncOptions} [options] */
function gitSync(args, options = {}) {
  // Electron discovery installs its process guard after the test setup preload.
  return childProcess.execFileSync("git", args, { ...options, env: gitEnvironment(options.env) });
}

/** @param {string[]} args @param {import("node:child_process").ExecFileOptions} [options] */
function git(args, options = {}) {
  return promisify(childProcess.execFile)("git", args, {
    ...options,
    encoding: "utf8",
    env: gitEnvironment(options.env),
  });
}

// Production deliberately strips inherited GIT_* settings. Enforce test config
// isolation at the process boundary, after that filtering, retaining its history
// overlay guards and every other process option (including stdin and timeout).
function optionsFor(file, options) {
  if (file !== "git") return options;
  return {
    ...options,
    env: {
      ...options?.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      ...identity,
    },
  };
}
function isolatedGitExecFile(file, args, options, callback) {
  if (file !== "git") return childProcess.execFile.apply(null, arguments);
  return childProcess.execFile(file, args, optionsFor(file, options), callback);
}
// Native promisified execFile also exposes .child, used to close/write stdin.
// Retain it by returning the native promise rather than an async wrapper.
isolatedGitExecFile[promisify.custom] = (file, args, options) =>
  promisify(childProcess.execFile)(file, args, optionsFor(file, options));

module.exports = { git, gitSync, gitEnvironment, isolatedGitExecFile };
