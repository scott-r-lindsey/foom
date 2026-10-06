// Main CI run #37247702288: Windows full suite 294s, individual flows up to
// 31s (40s on failure), versus roughly 1–3x faster Unix runners. One policy
// covers startup, assertions and teardown; timeouts remain failure deadlines.
const scale = process.platform === "win32" ? 3 : 1;
const deadline = (milliseconds) => milliseconds * scale;
const expect = require("@playwright/test").expect.configure({ timeout: deadline(10_000) });
module.exports = { deadline, expect };
