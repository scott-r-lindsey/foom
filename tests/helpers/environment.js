// These are test/build controls, never credentials or application session state.
// Keep this allowlist explicit: new FOOM_* session variables are isolated by default.
const runnerControls = new Set([
  "FOOM_ELECTRON_SHARD",
  "FOOM_PACKAGED_ROOT",
  "FOOM_REQUIRE_REMOTE_HOSTS",
  "FOOM_REMOTE_HOST_ARTIFACTS",
  "FOOM_TEST_DISK_ROOT",
  "FOOM_TEST_SHARED_MEMORY_ROOT",
  // Existing opt-in evidence controls belong to the runner, not the app fixture.
  "FOOM_SCREENSHOTS",
  "FOOM_HOST_KEY_SCREENSHOTS",
  "FOOM_AGY_SCREENSHOTS",
  "FOOM_CONFIRMATION_SCREENSHOTS",
  "FOOM_FORGE_SCREENSHOTS",
  "FOOM_MANUAL_SCREENSHOTS",
  "FOOM_PLACEMENT_SCREENSHOTS",
  "FOOM_POLISH_SCREENSHOTS",
  "FOOM_RELOAD_SCREENSHOTS",
  "FOOM_REOPEN_SCREENSHOTS",
  "FOOM_RESTORE_SCREENSHOTS",
  "FOOM_UI_SCREENSHOTS",
  "FOOM_UPDATE_SCREENSHOTS",
  "FOOM_CAPTURE_745",
  "FOOM_CAPTURE_856",
  "FOOM_COMPARE_PRODUCT_SHOTS",
  "FOOM_CPU_EVIDENCE",
  "FOOM_PREVIEW_PROFILE_BUNDLE",
  "FOOM_PREVIEW_PROFILE_WITH_PREVIEW",
  "FOOM_PREVIEW_MOVE_SCENARIO",
  "FOOM_PREVIEW_MOVE_REPORT",
  "FOOM_PREVIEW_MOVE_IDENTITY_MODULE",
]);

/** @param {NodeJS.ProcessEnv} [source] */
function fixtureEnvironment(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !key.toUpperCase().startsWith("FOOM_")),
  );
}

/** @param {NodeJS.ProcessEnv} [source] */
function runnerEnvironment(source = process.env) {
  return {
    ...fixtureEnvironment(source),
    ...Object.fromEntries(Object.entries(source).filter(([key]) => runnerControls.has(key))),
  };
}

module.exports = { fixtureEnvironment, runnerEnvironment };
