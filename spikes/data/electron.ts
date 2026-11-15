import { app } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./entry";

// No windows, preload, IPC, agent discovery, or ordinary profile startup.
const [directory, report] = process.argv.slice(app.isPackaged ? 1 : 2);
if (!directory || !report) throw new Error("Fixture requires explicit scratch and report paths");
app.setPath("userData", directory);
if (app.isPackaged) process.env.SPIKE_NATIVE_BINDING = join(process.resourcesPath, "app.asar.unpacked", "native.node");
app.whenReady().then(() => {
  try { writeFileSync(report, JSON.stringify(run(directory), null, 2)); app.exit(0); }
  catch (error) { console.error(error); app.exit(1); }
});
