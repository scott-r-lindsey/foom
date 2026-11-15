import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const input = process.argv[2] ?? "test-results/1098/measurements.json";
const data = JSON.parse(await readFile(input, "utf8"));
const delta = (events, from, to) => {
  const start = events.find((row) => row.stage === from)?.at;
  const end = events.find((row) => row.stage === to)?.at;
  return start === undefined || end === undefined ? null : Math.round((end - start) * 10) / 10;
};
const rows = data.runs.map((run) => {
  const events = [
    ...run.events,
    ...run.daemonEvents.map((row) => ({ stage: row.cost1098, at: row.at })),
  ];
  return {
    mode: run.mode,
    index: run.index,
    openMs: delta(events, "launch-start", "open-reply"),
    outputMs: delta(events, "launch-start", "pty-output-ready"),
    preflightMs: delta(events, "launch-start", "local-hash-start"),
    localVerificationMs: delta(events, "local-hash-start", "local-hash-end"),
    firstMarkerMs: delta(events, "ssh-spawn", run.index === 0 ? "FOOM-UPLOAD" : "FOOM-READY"),
    uploadMs: delta(events, "FOOM-UPLOAD", "FOOM-READY"),
    remoteHashMs: delta(events, "remote-hash-start", "remote-hash-end"),
    handshakeMs: delta(events, "FOOM-READY", "hello-reply"),
    connectorStartupMs: delta(events, "FOOM-READY", "entry"),
    connectorSelfHashMs: delta(events, "self-hash-start", "self-hash-end"),
    socketConnectMs: delta(events, "socket-start", "socket-connected"),
    socketToHelloMs: delta(events, "socket-connected", "hello-reply"),
    discoveryMs: delta(events, "discovery-start", "discovery-end"),
    preparationAndPtyMs: delta(events, "hello-reply", "open-reply"),
  };
});
assert.equal(rows.length, 14, "Expected one upload and six cached launches per version");
for (const row of rows) {
  for (const [key, value] of Object.entries(row)) {
    if (!key.endsWith("Ms")) continue;
    if (key === "uploadMs" && row.index > 0) assert.equal(value, null);
    else if (key === "connectorSelfHashMs" && row.mode === "fixed") assert.equal(value, null);
    else
      assert.ok(
        Number.isFinite(value) && value >= 0,
        `Missing/invalid interval: ${row.mode}/${row.index}/${key}`,
      );
  }
}
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length % 2
    ? sorted[Math.floor(sorted.length / 2)]
    : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) * 5) / 10;
};
const summary = {
  source: data.source,
  measuredAt: new Date(data.runs[0].events[0].at).toISOString(),
  node: data.node,
  platform: data.platform,
  arch: data.arch,
  executableBytes: data.runs[0].bytes,
  gzipBytes: {
    baseline: data.runs[0].gzipBytes,
    fixed: data.runs.find((row) => row.mode === "fixed").gzipBytes,
  },
  daemonStartup: { baseline: data.baselineDaemonStartup, fixed: data.fixedDaemonStartup },
  rows,
  cached: {},
};
for (const mode of ["baseline", "fixed"]) {
  const cached = rows.filter((row) => row.mode === mode && row.index > 0);
  summary.cached[mode] = {};
  for (const key of Object.keys(rows[0]).filter((key) => key.endsWith("Ms"))) {
    const values = cached.map((row) => row[key]).filter((value) => value !== null);
    summary.cached[mode][key] = values.length
      ? {
          median: median(values),
          min: Math.min(...values),
          max: Math.max(...values),
          n: values.length,
        }
      : null;
  }
}
await writeFile("test-results/1098/summary.json", `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
