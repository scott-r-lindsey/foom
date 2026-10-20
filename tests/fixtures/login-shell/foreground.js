// Runs as the foreground PTY job, independently of the observing test process.
const { readLoginShell, complete } = require(process.argv[4] || process.argv[2]);
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
console.log(`READY:${process.pid}`);
const release = setInterval(() => {
  try {
    if (readFileSync(join(process.env.HOME, "ready"), "utf8").trim().split("\n").length === 24) {
      writeFileSync(join(process.env.HOME, "release"), "");
      clearInterval(release);
    }
  } catch {
    /* Readers have not entered the fixture rc yet. */
  }
}, 10);
Promise.all(
  Array.from({ length: 24 }, () =>
    readLoginShell(process.argv[3], ["-ilc", "printf 'fixture-value'"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 256 * 1024,
      cwd: process.env.HOME,
    }),
  ),
)
  .then(
    async (results) => {
      if (results.some(({ stdout }) => stdout !== "fixture-value")) process.exitCode = 1;
      await complete?.();
      console.log("COMPLETE");
    },
    (error) => {
      clearInterval(release);
      console.error(error);
      process.exitCode = 1;
    },
  )
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
