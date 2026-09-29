import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const metricLabels = {
  statements: "Statements",
  branches: "Branches",
  functions: "Functions",
  lines: "Lines",
};

export function formatCoverageSummary(summary) {
  const rows = Object.entries(metricLabels).map(([metric, label]) => {
    const result = summary.total?.[metric];

    if (!result || typeof result.covered !== "number" || typeof result.total !== "number") {
      throw new Error(`Coverage summary is missing the ${metric} metric`);
    }

    return `| ${label} | ${result.covered} | ${result.total} | ${result.pct}% |`;
  });

  return [
    "<!-- foom-coverage -->",
    "## Coverage report",
    "",
    "| Metric | Covered | Total | Coverage |",
    "| --- | ---: | ---: | ---: |",
    ...rows,
    "",
    "The complete HTML and LCOV reports are available in the `coverage-report` workflow artifact.",
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , inputPath, outputPath] = process.argv;

  if (!inputPath || !outputPath) {
    throw new Error("Usage: node tools/format_coverage_summary.mjs <input.json> <output.md>");
  }

  const summary = JSON.parse(await readFile(inputPath, "utf8"));
  await writeFile(outputPath, formatCoverageSummary(summary));
}
