import { getAsset } from "node:sea";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { run } from "./entry";

// Same extraction/verification shape as foom-host's SEA PTY loader. Only the
// fallback requires an asset; node:sqlite lives in the runtime itself.
const [directory, report] = process.argv.slice(2);
if (!directory || !report) throw new Error("Explicit scratch and report paths required");
// The parent owns extraction cleanup AFTER this process exits. Windows keeps a
// loaded native DLL locked for the process lifetime, even after DB.close().
const scratch = join(directory, "native");
mkdirSync(scratch, { mode: 0o700 });
const bytes = Buffer.from(getAsset("better_sqlite3.node"));
const expected = getAsset("native.sha256", "utf8").trim();
if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Native asset hash mismatch");
const native = join(scratch, "better_sqlite3.node");
writeFileSync(native, bytes, { mode: 0o600 });
process.env.SPIKE_NATIVE_BINDING = native;
writeFileSync(report, JSON.stringify(run(directory), null, 2));
