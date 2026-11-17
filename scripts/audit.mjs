import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const fail = (message) => {
  throw new Error(message);
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

function findings(report) {
  if (
    !object(report) ||
    !object(report.advisories) ||
    !Array.isArray(report.muted) ||
    report.muted.length !== 0 ||
    report.error ||
    !object(report.metadata?.vulnerabilities)
  )
    fail("Audit failed: invalid audit report.");
  const severities = ["info", "low", "moderate", "high", "critical"];
  const counted = report.metadata.vulnerabilities;
  const counts = severities.map((severity) => counted[severity]);
  const entries = Object.values(report.advisories);
  if (
    Object.keys(counted).length !== severities.length ||
    !severities.every((severity) => Object.hasOwn(counted, severity)) ||
    !counts.every((count) => Number.isSafeInteger(count) && count >= 0) ||
    counts.reduce((sum, count) => sum + count, 0) !== entries.length
  )
    fail("Audit failed: invalid audit report.");
  for (const entry of entries) {
    if (
      !object(entry) ||
      !/^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/.test(
        entry.github_advisory_id,
      ) ||
      !nonempty(entry.module_name) ||
      !nonempty(entry.vulnerable_versions) ||
      !Array.isArray(entry.findings) ||
      entry.findings.length === 0 ||
      !entry.findings.every(
        (finding) =>
          object(finding) &&
          nonempty(finding.version) &&
          Array.isArray(finding.paths) &&
          finding.paths.length > 0 &&
          finding.paths.every(nonempty),
      )
    )
      fail("Audit failed: invalid audit report.");
  }
  return entries;
}

export function validateAudit(all, production, exceptions, now = new Date()) {
  if (!Array.isArray(exceptions)) fail("Audit failed: malformed exception.");
  const ids = new Set();
  for (const entry of exceptions) {
    if (
      !object(entry) ||
      Object.keys(entry).sort().join(",") !==
        "cve,expires,ghsa,issue,justification,package,upstreamFix,vulnerableVersions" ||
      !/^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/.test(
        entry.ghsa,
      ) ||
      !/^CVE-\d{4}-\d{4,}$/.test(entry.cve) ||
      typeof entry.upstreamFix !== "string" ||
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(
        entry.upstreamFix,
      ) ||
      !nonempty(entry.package) ||
      !nonempty(entry.vulnerableVersions) ||
      !nonempty(entry.justification) ||
      !Number.isSafeInteger(entry.issue) ||
      entry.issue <= 0 ||
      typeof entry.expires !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires) ||
      !Number.isFinite(Date.parse(entry.expires)) ||
      new Date(entry.expires).toISOString().slice(0, 10) !== entry.expires ||
      ids.has(entry.ghsa)
    )
      fail("Audit failed: malformed exception.");
    ids.add(entry.ghsa);
    // The date is inclusive in UTC; fail closed if the clock is invalid.
    if (!Number.isFinite(now.getTime()) || now.toISOString().slice(0, 10) > entry.expires)
      fail("Audit failed: expired exception.");
  }
  const allFindings = findings(all);
  const prodFindings = findings(production);
  for (const entry of exceptions) {
    if (prodFindings.some((finding) => finding.github_advisory_id === entry.ghsa))
      fail("Audit failed: exception found in production.");
    const matches = allFindings.filter((finding) => finding.github_advisory_id === entry.ghsa);
    if (matches.length === 0) fail("Audit failed: stale exception.");
    if (
      matches.some(
        (finding) =>
          finding.module_name !== entry.package ||
          finding.vulnerable_versions !== entry.vulnerableVersions ||
          finding.patched_versions !== "<0.0.0",
      )
    )
      fail("Audit failed: exception does not match an unpatched advisory.");
  }
  if ([...allFindings, ...prodFindings].some((finding) => !ids.has(finding.github_advisory_id)))
    fail("Audit failed: unexcepted advisory.");
}

export function readAudit(args, execute = execFileSync, executable = process.env.npm_execpath) {
  if (!executable) fail("Audit failed: run with pnpm run audit.");
  const isScript = /\.[cm]?js$/.test(executable);
  let output;
  try {
    output = execute(
      isScript ? process.execPath : executable,
      [...(isScript ? [executable] : []), "audit", "--json", "--audit-level=low", ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (error) {
    if (error.status !== 1 || typeof error.stdout !== "string")
      fail("Audit failed: audit command failed.");
    output = error.stdout;
    // Exit 1 is only expected for a valid report containing advisories.
    let report;
    try {
      report = JSON.parse(output);
    } catch {
      fail("Audit failed: invalid audit report.");
    }
    if (findings(report).length === 0) fail("Audit failed: audit command failed.");
  }
  try {
    return JSON.parse(output);
  } catch {
    fail("Audit failed: invalid audit report.");
  }
}

export function runAudit(read = readAudit, now = new Date()) {
  const exceptions = JSON.parse(
    readFileSync(new URL("./audit-exceptions.json", import.meta.url), "utf8"),
  );
  validateAudit(read([]), read(["--prod"]), exceptions, now);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runAudit();
    console.info("Audit passed with validated, expiring development-only exceptions.");
  } catch (error) {
    console.error(
      error instanceof Error && error.message.startsWith("Audit failed:")
        ? error.message
        : "Audit failed: invalid audit configuration.",
    );
    process.exitCode = 1;
  }
}
