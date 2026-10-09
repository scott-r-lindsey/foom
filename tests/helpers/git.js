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

module.exports = { git, gitSync, gitEnvironment };
