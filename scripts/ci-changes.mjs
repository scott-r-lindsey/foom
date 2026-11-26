import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { selectAffected } from "./electron-affected.mjs";
import { suiteFiles } from "../tests/electron/test-suites.js";

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
const platformsByJob = { linux: "ubuntu-24.04", windows: "windows-2025", macos: "macos-15" };
export const allPlatforms = Object.values(platformsByJob);

const { shardCounts } = JSON.parse(
  readFileSync(new URL("../tests/electron/shard-plan.json", import.meta.url), "utf8"),
);

/** Platform counts follow the measured headroom in the checked-in plan. */
export function desktopMatrix(platforms = allPlatforms) {
  return platforms.flatMap((os) => {
    const count = shardCounts[os];
    return Array.from({ length: count }, (_, index) => ({ os, shard: `${index + 1}/${count}` }));
  });
}

// Only an explicit draft PR can reduce Electron coverage. All other events
// retain the full matrix, including ready_for_review without another push.
export function electronSelection(
  eventName,
  event,
  diff = (range) =>
    execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", range, "--"], {
      encoding: "utf8",
    }),
  inventory = suiteFiles().map((file) => file.split(/[\\/]/).at(-1)),
) {
  if (
    eventName !== "pull_request" ||
    event.action === "ready_for_review" ||
    event.pull_request?.draft !== true
  )
    return [];
  const { base, head } = event.pull_request;
  if (![base?.sha, head?.sha].every((sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha)))
    throw new Error("Missing or invalid comparison commit");
  try {
    const selection = selectAffected(diff(`${base.sha}...${head.sha}`).split("\0").filter(Boolean));
    return selection.suites.every((suite) => inventory.includes(suite)) ? selection.suites : [];
  } catch {
    // Unavailable comparison history must never narrow coverage.
    return [];
  }
}

export function detectDesktop(
  eventName,
  event,
  diff = (range) =>
    execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", range, "--"], {
      encoding: "utf8",
    }),
  published = process.env.NIGHTLY_ALREADY_PUBLISHED,
) {
  if (eventName === "schedule") {
    if (published !== "true" && published !== "false")
      throw new Error("Missing scheduled nightly publication status");
    return published === "false";
  }
  // Manual runs and unknown events always exercise every supported platform.
  if (eventName !== "pull_request" && eventName !== "push") return true;
  const base = eventName === "pull_request" ? event.pull_request?.base?.sha : event.before;
  const head = eventName === "pull_request" ? event.pull_request?.head?.sha : event.after;
  if (![base, head].every((sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha))) {
    throw new Error("Missing or invalid comparison commit");
  }
  if (eventName === "pull_request" && event.action === "ready_for_review") return true;
  // A new branch has no previous commit to compare; validate the whole app.
  if (/^0+$/.test(base)) return true;
  const range = `${base}${eventName === "pull_request" ? "..." : ".."}${head}`;
  const changed = diff(range);
  return requiresDesktop(changed.split("\0").filter(Boolean));
}

function workflowFingerprint(sha) {
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) return "";
  try {
    const bytes = execFileSync("git", ["show", `${sha}:.github/workflows/ci.yml`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    // A workflow commit unavailable in the checkout cannot prove reuse.
    return "";
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const required = detectDesktop(process.env.GITHUB_EVENT_NAME, event);
  const suites = electronSelection(process.env.GITHUB_EVENT_NAME, event);
  const matrices = Object.entries(platformsByJob).map(([job, os]) => {
    const matrix = suites.length > 0 ? [{ os, shard: "1/1" }] : desktopMatrix([os]);
    return `desktop_matrix_${job}=${JSON.stringify(matrix)}`;
  });
  const outputs = [
    `desktop_required=${required}`,
    ...matrices,
    `electron_suites=${JSON.stringify(suites)}`,
  ];
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    const fingerprint = workflowFingerprint(process.env.GITHUB_WORKFLOW_SHA);
    if (fingerprint) outputs.push(`workflow_fingerprint=${fingerprint}`);
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join("\n")}\n`);
  console.log(
    required
      ? `Desktop validation required on ${allPlatforms.join(", ")}.`
      : "No desktop-relevant changes; desktop validation skipped.",
  );
}
