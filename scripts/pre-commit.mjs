import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Resolve the hook's repository before discarding Git's exported selectors.
const common = resolve(
  execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim(),
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
);
const git = (args) => execFileSync("git", args, { env, encoding: "utf8" });
const config = resolve(common, "config");
function values(key) {
  try {
    return git(["config", "--file", config, "--null", "--get-all", key]).split("\0").slice(0, -1);
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}
const keys = ["core.bare", "core.worktree"];
const before = keys.map(values);
const bare = () => git(["rev-parse", "--is-bare-repository"]).trim();
const wasBare = bare();
const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "check"], {
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
let changed;
try {
  changed =
    keys.some((key, index) => JSON.stringify(values(key)) !== JSON.stringify(before[index])) ||
    bare() !== wasBare;
} catch {
  changed = true;
}
if (changed) {
  for (const [index, key] of keys.entries()) {
    try {
      git(["config", "--file", config, "--unset-all", key]);
    } catch (error) {
      if (error.status !== 5) throw error;
    }
    for (const value of before[index]) git(["config", "--file", config, "--add", key, value]);
  }
  console.error(
    "Pre-commit refused: a test wrote to the real repository's shape. Restored core.bare and core.worktree; investigate the check before committing.",
  );
}
if (result.error) console.error(result.error.message);
process.exitCode = changed ? 1 : (result.status ?? 1);
