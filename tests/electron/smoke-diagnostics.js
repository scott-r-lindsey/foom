const { appendFileSync, mkdirSync } = require("node:fs");
const { dirname } = require("node:path");

// Node's test runner can lose buffered test diagnostics when its worker crashes.
// Persist each checkpoint immediately, without recording environment or argv.
function smokeDiagnostics(file) {
  mkdirSync(dirname(file), { recursive: true });
  const record = (stage, details = {}) => {
    const resources = {};
    for (const type of process.getActiveResourcesInfo())
      resources[type] = (resources[type] ?? 0) + 1;
    appendFileSync(
      file,
      `${JSON.stringify({
        time: new Date().toISOString(),
        pid: process.pid,
        stage,
        resources,
        nativeModules: Object.keys(require.cache).filter((file) => file.endsWith(".node")),
        ...details,
      })}\n`,
    );
  };
  process.on("beforeExit", (code) => record("worker beforeExit", { code }));
  process.on("exit", (code) => record("worker exit", { code }));
  record("worker started", {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  });
  return record;
}

module.exports = { smokeDiagnostics };
