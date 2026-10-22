// Summarize three interleaved runs per variant; raw traces stay in test-results/.
import { readFileSync, readdirSync } from "node:fs";
const prefix = process.argv[2] || "final";
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const spread = (values) => ({
  median: median(values),
  min: Math.min(...values),
  max: Math.max(...values),
});
const groups = {};
for (const file of readdirSync("test-results").sort()) {
  const match = new RegExp(`^${prefix}-([a-z]+)-([123])-streaming\\.json$`).exec(file);
  if (!match) continue;
  const report = JSON.parse(readFileSync(`test-results/${file}`, "utf8"));
  const sortedFrames = report.frameTimes.toSorted((a, b) => a - b);
  const renderer = report.cpu
    .filter((process) => process.type === "Tab")
    .sort((a, b) => b.percent - a.percent)[0];
  const gpu = report.cpu.find((process) => process.type === "GPU");
  (groups[match[1]] ??= []).push({
    file,
    rendererCPU: renderer.percent,
    gpuCPU: gpu.percent,
    echoMedianMs: median(report.latency),
    echoSamplesMs: report.latency,
    frameP95Ms: sortedFrames[Math.floor(sortedFrames.length * 0.95)],
    rendererWorkingSetKB: renderer.workingSetKB,
    gpuWorkingSetKB: gpu.workingSetKB,
    dataMessages: report.messages.data,
    units: report.messages.units,
    acknowledgements: report.ipc.ack,
    elapsedMs: report.elapsed,
  });
}
const result = {};
for (const [variant, runs] of Object.entries(groups)) {
  result[variant] = { runs, summary: {} };
  for (const metric of [
    "rendererCPU",
    "gpuCPU",
    "echoMedianMs",
    "frameP95Ms",
    "rendererWorkingSetKB",
    "gpuWorkingSetKB",
    "acknowledgements",
  ])
    if (runs.every((run) => typeof run[metric] === "number"))
      result[variant].summary[metric] = spread(runs.map((run) => run[metric]));
}
console.log(JSON.stringify(result, null, 2));
