// ONE explicitly authorized real-desktop session. No GPU flags or fallback retries.
const { test } = require("node:test");
const { measure } = require("./measure.cjs");
if (process.env.FOOM_WEBGL_DESKTOP_SESSION !== "1")
  throw new Error("Requires explicit one-session authorization");
let available = true;
const budget = setTimeout(() => {
  console.error("Desktop session exceeded ten-minute budget");
  process.exit(1);
}, 600000);
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
