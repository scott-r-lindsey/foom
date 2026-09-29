import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const annotationLimit = 10;

export function parseLcov(lcov) {
  const files = new Map();
  let currentFile;

  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      currentFile = line.slice(3);
      files.set(currentFile, new Map());
    } else if (line.startsWith("DA:") && currentFile) {
      const [lineNumber, hits] = line.slice(3).split(",").map(Number);
      files.get(currentFile).set(lineNumber, hits);
    } else if (line === "end_of_record") {
      currentFile = undefined;
    }
  }

  return files;
}

export function parseChangedLines(diff) {
  const files = new Map();
  let currentFile;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      currentFile = path === "/dev/null" ? undefined : path.replace(/^b\//, "");
    } else if (line.startsWith("@@ ") && currentFile) {
      const match = line.match(/\+(\d+)(?:,(\d+))?/);
      if (!match) continue;

      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      const changed = files.get(currentFile) ?? new Set();

      for (let lineNumber = start; lineNumber < start + count; lineNumber += 1) {
        changed.add(lineNumber);
      }

      files.set(currentFile, changed);
    }
  }

  return files;
}

function groupContiguousLines(lines) {
  const groups = [];

  for (const line of lines) {
    const previous = groups.at(-1);
    if (previous?.end === line - 1) {
      previous.end = line;
    } else {
      groups.push({ start: line, end: line });
    }
  }

  return groups;
}

function escapeCommandProperty(value) {
  return String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

function formatLocation(path, group) {
  const lines = group.start === group.end ? `${group.start}` : `${group.start}-${group.end}`;
  return `\`${path}:${lines}\``;
}

export function reportChangedCoverage(lcov, diff, minimum = 90) {
  const coverage = parseLcov(lcov);
  const changes = parseChangedLines(diff);
  const coveredGroups = [];
  const uncoveredGroups = [];
  const missingFiles = [];
  let covered = 0;
  let total = 0;

  for (const [path, changedLines] of changes) {
    const fileCoverage = coverage.get(path);
    if (!fileCoverage) {
      if (
        changedLines.size > 0 &&
        path.startsWith("src/") &&
        /\.tsx?$/.test(path) &&
        !path.endsWith(".d.ts")
      )
        missingFiles.push(path);
      continue;
    }

    const coveredLines = [];
    const uncoveredLines = [];

    for (const line of [...changedLines].sort((left, right) => left - right)) {
      const hits = fileCoverage.get(line);
      if (hits === undefined) continue;

      total += 1;
      if (hits > 0) {
        covered += 1;
        coveredLines.push(line);
      } else {
        uncoveredLines.push(line);
      }
    }

    coveredGroups.push(...groupContiguousLines(coveredLines).map((group) => ({ path, ...group })));
    uncoveredGroups.push(
      ...groupContiguousLines(uncoveredLines).map((group) => ({ path, ...group })),
    );
  }

  const commands = [
    ...coveredGroups
      .slice(0, annotationLimit)
      .map(
        ({ path, start, end }) =>
          `::notice file=${escapeCommandProperty(path)},line=${start},endLine=${end},title=Covered by tests::Changed executable lines are covered.`,
      ),
    ...uncoveredGroups
      .slice(0, annotationLimit)
      .map(
        ({ path, start, end }) =>
          `::warning file=${escapeCommandProperty(path)},line=${start},endLine=${end},title=Not covered by tests::Changed executable lines are not covered.`,
      ),
  ];

  const markdown = ["## Changed-line coverage", ""];
  if (total === 0) {
    markdown.push("No changed executable lines appear in the LCOV report.", "");
  } else {
    const percentage = Math.round((covered / total) * 10_000) / 100;
    markdown.push(
      `${covered} of ${total} changed executable lines are covered (${percentage}%).`,
      "",
    );

    if (uncoveredGroups.length > 0) {
      markdown.push(
        "Uncovered changed locations:",
        "",
        ...uncoveredGroups.slice(0, 20).map((group) => `- ${formatLocation(group.path, group)}`),
      );
      if (uncoveredGroups.length > 20) {
        markdown.push(`- …and ${uncoveredGroups.length - 20} more ranges`);
      }
      markdown.push("");
    }
  }

  const passed = missingFiles.length === 0 && (total === 0 || (covered / total) * 100 >= minimum);
  for (const path of missingFiles) {
    commands.push(
      `::error file=${escapeCommandProperty(path)},title=Missing coverage::Changed application file is absent from LCOV.`,
    );
    markdown.push(`Missing coverage data: \`${path}\``, "");
  }
  markdown.push(`Changed-line minimum: ${minimum}%. **${passed ? "Passed" : "Failed"}**.`, "");
  return { commands, markdown: markdown.join("\n"), covered, total, missingFiles, passed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , lcovPath, diffPath, outputPath] = process.argv;

  if (!lcovPath || !diffPath || !outputPath) {
    throw new Error(
      "Usage: node scripts/report-changed-coverage.mjs <lcov.info> <diff.patch> <output.md>",
    );
  }

  const [lcov, diff] = await Promise.all([readFile(lcovPath, "utf8"), readFile(diffPath, "utf8")]);
  const report = reportChangedCoverage(lcov, diff);
  for (const command of report.commands) console.log(command);
  await writeFile(outputPath, report.markdown);
  if (!report.passed) process.exitCode = 1;
}
