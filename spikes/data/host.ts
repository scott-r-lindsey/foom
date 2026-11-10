import { getAsset } from "node:sea";
import { createHash } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./entry";

// Same extraction/verification shape as foom-host's SEA PTY loader. Only the
// fallback requires an asset; node:sqlite lives in the runtime itself.
const scratch = mkdtempSync(join(tmpdir(), "foom-data-native-"));
try {
  const bytes = Buffer.from(getAsset("better_sqlite3.node"));
  const expected = getAsset("native.sha256", "utf8").trim();
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Native asset hash mismatch");
  const native = join(scratch, "better_sqlite3.node");
  writeFileSync(native, bytes, { mode: 0o600 });
  process.env.SPIKE_NATIVE_BINDING = native;
  const [directory, report] = process.argv.slice(2);
  if (!directory || !report) throw new Error("Explicit scratch and report paths required");
  writeFileSync(report, JSON.stringify(run(directory), null, 2));
} finally { rmSync(scratch, { recursive: true, force: true }); }
