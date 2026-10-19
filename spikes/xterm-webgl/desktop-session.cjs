// ONE explicitly authorized real-desktop session. No GPU flags or fallback retries.
const { test, after } = require("node:test");
const { writeFileSync } = require("node:fs");
const startedAt = Number(process.env.FOOM_WEBGL_SESSION_STARTED_MS || Date.now());
const remaining = 600000 - (Date.now() - startedAt);
if (remaining <= 0) throw new Error("Authorized measurement window expired");
after(() =>
  writeFileSync(
    "spikes/xterm-webgl/results/hardware-session.json",
    JSON.stringify(
      {
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        hardwareAvailable: available,
        recoveredStartupError:
          process.env.FOOM_WEBGL_RECOVERED_STARTUP === "1"
            ? "Initial fixture startup failed before GPU preflight because the display created multiple blank tiles; corrected under Xvfb within the same ten-minute window"
            : undefined,
        addedGpuSwitches: [],
      },
      null,
      2,
    ) + "\n",
  ),
);
const { measure } = require("./measure.cjs");
if (process.env.FOOM_WEBGL_DESKTOP_SESSION !== "1")
  throw new Error("Requires explicit one-session authorization");
let available = true;
const budget = setTimeout(() => {
  console.error("Desktop session exceeded ten-minute budget");
  process.exit(1);
}, remaining);
budget.unref();
let first = true;
for (const renderer of ["dom", "webgl"])
  for (const tiles of [4, 9]) {
    test(`hardware ${renderer} ${tiles} streaming tiles`, { timeout: 60000 }, async (context) => {
      if (!available) {
        context.skip("First preflight found no hardware WebGL; no retry permitted");
        return;
      }
      let result;
      try {
        result = await measure(context, {
          tiles,
          renderer,
          desktop: true,
          preflight: first,
          output: `spikes/xterm-webgl/results/hardware-${renderer}-${tiles}.json`,
        });
      } catch (error) {
        available = false;
        throw error;
      }
      first = false;
      if (!result.hardware) {
        available = false;
        context.diagnostic(
          "Hardware WebGL unavailable; recorded hardware-status.json and stopped without retrying flags",
        );
      }
    });
  }
