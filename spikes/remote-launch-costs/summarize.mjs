import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const input = process.argv[2] ?? "test-results/1098-startup/measurements.json";
const data = JSON.parse(await readFile(input, "utf8"));
const elapsed = (events, from, to) => {
  const start = events.find((row) => row.stage === from)?.at;
  const end = events.find((row) => row.stage === to)?.at;
  return start === undefined || end === undefined ? null : end - start;
};
const roundMs = (value) => Math.round(value * 10) / 10;
const delta = (events, from, to) => {
  const value = elapsed(events, from, to);
  return value === null ? null : roundMs(value);
};
const realSsh = data.transport === "loopback" || data.runs[0]?.sshEvents.some(({ stage }) => stage === "bootstrap-ssh-authenticated");
const rows = data.runs.map((run) => {
  const events = [
    ...run.events,
    ...run.sshEvents,
    ...run.daemonEvents.map((row) => ({ stage: row.cost1098, at: row.at })),
  ];
  const firstMarker = run.index === 0 ? "FOOM-UPLOAD" : "FOOM-READY";
  let authenticatedToMarkerMs;
  if (realSsh) {
    const value = elapsed(events, "bootstrap-ssh-authenticated", firstMarker);
    assert.ok(Number.isFinite(value), `Missing/invalid interval: ${run.mode}/${run.index}/authenticatedToMarkerMs`);
    // Independent stderr and stdout readers can observe these events out of order.
    authenticatedToMarkerMs = value < 0 ? null : roundMs(value);
  }
  return {
    mode: run.mode,
    index: run.index,
    openMs: delta(events, "launch-start", "open-reply"),
    outputMs: delta(events, "launch-start", "pty-output-ready"),
    preflightMs: delta(events, "launch-start", "local-hash-start"),
    ...(realSsh ? {
      preflightAuthMs: delta(events, "preflight-ssh-start", "preflight-ssh-authenticated"),
      bootstrapAuthMs: delta(events, "bootstrap-ssh-start", "bootstrap-ssh-authenticated"),
      authenticatedToMarkerMs,
      openToPtyMs: delta(events, "open-reply", "pty-output-ready"),
    } : {}),
    artifactReadMs: delta(events, "artifact-read-start", "artifact-read-end"),
    artifactKeyMs: delta(events, "artifact-key-start", "artifact-key-end"),
    localVerificationMs: delta(events, "local-hash-start", "local-hash-end"),
    firstMarkerMs: delta(events, "ssh-spawn", firstMarker),
    uploadMs: delta(events, "FOOM-UPLOAD", "FOOM-READY"),
    remoteHashMs: delta(events, "remote-hash-start", "remote-hash-end"),
    handshakeMs: delta(events, "FOOM-READY", "hello-reply"),
    moduleInitializationMs: delta(events, "bundle-entry", "entry"),
    connectorStartupMs: delta(events, "FOOM-READY", "entry"),
    connectorSelfHashMs: delta(events, "self-hash-start", "self-hash-end"),
    socketConnectMs: delta(events, "socket-start", "socket-connected"),
    socketToHelloMs: delta(events, "socket-connected", "hello-reply"),
    discoveryMs: delta(events, "discovery-start", "discovery-end"),
    preparationAndPtyMs: delta(events, "hello-reply", "open-reply"),
  };
});
assert.equal(rows.length, realSsh ? 7 : 14, "Expected one upload and six cached launches per version");
for (const row of rows) {
  for (const [key, value] of Object.entries(row)) {
    if (!key.endsWith("Ms")) continue;
    if (key === "uploadMs" && row.index > 0) assert.equal(value, null);
    else if (key === "connectorSelfHashMs") assert.equal(value, null);
    else if (key === "authenticatedToMarkerMs" && value === null) continue;
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
  outputDirectory: input.slice(0, input.lastIndexOf("/")),
  executableBytes: data.runs[0].bytes,
  gzipBytes: {
    ...(realSsh ? {} : { baseline: data.runs.find((row) => row.mode === "baseline").gzipBytes }),
    fixed: data.runs.find((row) => row.mode === "fixed").gzipBytes,
  },
  daemonStartup: { baseline: data.baselineDaemonStartup, fixed: data.fixedDaemonStartup },
  rows,
  cached: {},
};
for (const mode of realSsh ? ["fixed"] : ["baseline", "fixed"]) {
  const cached = rows.filter((row) => row.mode === mode && row.index > 0);
  summary.cached[mode] = {};
  for (const key of Object.keys(rows[0]).filter((key) => key.endsWith("Ms"))) {
    const values = cached.map((row) => row[key]).filter((value) => value !== null);
    const stats = values.length
      ? {
          median: median(values),
          min: Math.min(...values),
          max: Math.max(...values),
          n: values.length,
        }
      : null;
    summary.cached[mode][key] = key === "authenticatedToMarkerMs"
      ? { ...stats, n: values.length, unavailable: cached.length - values.length }
      : stats;
  }
}
await writeFile(`${summary.outputDirectory}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
