import { run } from "./entry";
import { writeFileSync } from "node:fs";
const [directory, report] = process.argv.slice(2);
if (!directory || !report) throw new Error("Explicit scratch and report paths required");
writeFileSync(report, JSON.stringify(run(directory), null, 2));
