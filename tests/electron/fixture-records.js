const { existsSync, readFileSync, watch } = require("node:fs");
const path = require("node:path");

// Fixture records are atomically renamed into place. Wait for that event rather
// than spending an assertion's budget on a production handoff cooldown.
async function waitForFixtureRecord(file, errors, signal) {
  let watcher;
  let abort;
  try {
    await new Promise((resolve, reject) => {
      const check = () => {
        try {
          for (const error of errors) {
            if (existsSync(error))
              throw new Error(`${path.basename(error)}: ${readFileSync(error, "utf8")}`);
          }
          if (existsSync(file)) resolve();
        } catch (error) {
          reject(error);
        }
      };
      abort = () => reject(signal.reason);
      watcher = watch(path.dirname(file), check);
      watcher.on("error", reject);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      // Subscribe before checking: a record written during setup cannot be lost.
      check();
    });
  } finally {
    watcher?.close();
    if (abort) signal.removeEventListener("abort", abort);
  }
}

module.exports = { waitForFixtureRecord };
