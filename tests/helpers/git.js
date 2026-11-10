const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);

/** @param {NodeJS.ProcessEnv} [source] */
function gitEnvironment(source = process.env) {
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
    ),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/** @param {string[]} args @param {import("node:child_process").ExecFileSyncOptions} [options] */
function gitSync(args, options = {}) {
  return execFileSync("git", args, { ...options, env: gitEnvironment(options.env) });
}

/** @param {string[]} args @param {import("node:child_process").ExecFileOptions} [options] */
function git(args, options = {}) {
  return execute("git", args, { ...options, encoding: "utf8", env: gitEnvironment(options.env) });
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
    },
  };
}
function isolatedGitExecFile(file, args, options, callback) {
  if (file !== "git") return execFile.apply(null, arguments);
  return execFile(file, args, optionsFor(file, options), callback);
}
// Native promisified execFile also exposes .child, used to close/write stdin.
// Retain it by returning the native promise rather than an async wrapper.
isolatedGitExecFile[promisify.custom] = (file, args, options) =>
  execute(file, args, optionsFor(file, options));

module.exports = { git, gitSync, gitEnvironment, isolatedGitExecFile };
