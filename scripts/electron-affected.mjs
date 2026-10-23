import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { suiteFiles } from "../tests/electron/test-suites.js";

// Deliberately narrow: new areas require an explicit coverage review here.
const mappings = [
  [/^src\/renderer\/preview\//, ["previews"]],
  [/^src\/renderer\/terminal\//, ["terminal", "webgl", "workspace", "previews"]],
  [
    /^src\/renderer\/sound\/(?:volume-control\.tsx|sound-controls\.tsx|recording\.ts)$/,
    [
      "preflight",
      "settings-accessibility",
      "settings-appearance",
      "settings-sound",
      "settings-agents",
      "settings-general",
    ],
  ],
];

export function selectAffected(paths) {
  const suites = new Set();
  if (paths.length === 0) return { full: true, reason: "No changed paths", suites: [] };
  for (const path of [...new Set(paths)].sort()) {
    const mapping = mappings.find(([pattern]) => pattern.test(path));
    if (!mapping) return { full: true, reason: `Unmapped path: ${path}`, suites: [] };
    for (const suite of mapping[1]) suites.add(`${suite}.test.js`);
  }
  return {
    full: false,
    reason: "All changed paths have explicit mappings",
    suites: [...suites].sort(),
  };
}

export function changedPaths(
  base = "origin/main",
  git = (args) => execFileSync("git", args, { encoding: "utf8" }),
) {
  // Resolve before constructing a range; options and revision expressions cannot
  // become arguments to diff. Disable renames so both sides are classified.
  const revision = git(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]).trim();
  const ancestor = git(["merge-base", revision, "HEAD"]).trim();
  return [
    ...new Set(
      [
        ...git(["diff", "--name-only", "--no-renames", "-z", ancestor, "HEAD", "--"]).split("\0"),
        ...git(["diff", "--cached", "--name-only", "--no-renames", "-z", "--"]).split("\0"),
        ...git(["diff", "--name-only", "--no-renames", "-z", "--"]).split("\0"),
        ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
      ].filter(Boolean),
    ),
  ].sort();
}

export function runAffected({
  base = "origin/main",
  platform = process.platform,
  env = process.env,
  paths = changedPaths,
  run = spawnSync,
  inventory = suiteFiles().map((file) => file.split(/[\\/]/).at(-1)),
} = {}) {
  if (env.FOOM_ELECTRON_SHARD)
    throw new Error("Affected local runs require FOOM_ELECTRON_SHARD to be unset");
  let selection;
  try {
    selection = selectAffected(paths(base));
  } catch {
    selection = { full: true, reason: `Cannot compare with ${base}`, suites: [] };
  }
  if (selection.suites.some((suite) => !inventory.includes(suite))) {
    selection = { full: true, reason: "Mapped suite missing from inventory", suites: [] };
  }
  console.info(
    `Electron affected: ${selection.full ? "full suite" : selection.suites.join(", ")} (${selection.reason}).`,
  );
  const args = [
    "scripts/electron-tests.mjs",
    ...selection.suites.map((suite) => `--suite=${suite}`),
  ];
  const result =
    platform === "linux"
      ? run("xvfb-run", ["-a", process.execPath, ...args], { stdio: "inherit" })
      : run(process.execPath, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 3) throw new Error("Usage: pnpm run test:electron:affected [base]");
  process.exitCode = runAffected({ base: process.argv[2] });
}
