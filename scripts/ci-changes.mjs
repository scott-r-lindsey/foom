import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const documentationFiles = new Set(["README.md", "AGENTS.md", "LICENSE", "NOTICE"]);

export function requiresDesktop(paths) {
  return (
    paths.length === 0 ||
    paths.some(
      (path) =>
        !(
          documentationFiles.has(path) ||
          /^docs\/[^\r\n]+\.md$/.test(path) ||
          /^docs\/mockups\/[^/\r\n]+\.html$/.test(path) ||
          path.startsWith("inspiration/") ||
          path.startsWith("spikes/")
        ),
    )
  );
}

/** Every run, including draft pull requests, validates all three platforms. */
export const allPlatforms = ["ubuntu-24.04", "windows-2025", "macos-15"];

/** Windows runs two disjoint test shards. */
export function desktopMatrix(platforms = allPlatforms) {
  return platforms.flatMap((os) =>
    (os === "windows-2025" ? ["1/2", "2/2"] : ["1/1"]).map((shard) => ({ os, shard })),
  );
}

export function detectDesktop(
  eventName,
  event,
  diff = (range) =>
    execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", range, "--"], {
      encoding: "utf8",
    }),
  recentCommit = () =>
    execFileSync("git", ["log", "-1", "--since=25 hours ago", "--format=%H"], {
      encoding: "utf8",
    }),
) {
  // The nightly run validates every platform only when main changed since the last one.
  if (eventName === "schedule") return recentCommit().trim() !== "";
  // Manual runs and unknown events always exercise every supported platform.
  if (eventName !== "pull_request" && eventName !== "push") return true;
  const base = eventName === "pull_request" ? event.pull_request?.base?.sha : event.before;
  const head = eventName === "pull_request" ? event.pull_request?.head?.sha : event.after;
  if (![base, head].every((sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha))) {
    throw new Error("Missing or invalid comparison commit");
  }
  // A new branch has no previous commit to compare; validate the whole app.
  if (/^0+$/.test(base)) return true;
  const range = `${base}${eventName === "pull_request" ? "..." : ".."}${head}`;
  const changed = diff(range);
  return requiresDesktop(changed.split("\0").filter(Boolean));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const required = detectDesktop(process.env.GITHUB_EVENT_NAME, event);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `desktop_required=${required}\ndesktop_matrix=${JSON.stringify(desktopMatrix())}\n`,
  );
  console.log(
    required
      ? `Desktop validation required on ${allPlatforms.join(", ")}.`
      : "No desktop-relevant changes; desktop validation skipped.",
  );
}
