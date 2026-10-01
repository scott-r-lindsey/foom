import { access } from "node:fs/promises";

const report = new URL("../coverage/index.html", import.meta.url);
await access(report);
console.info(`HTML coverage report: ${report.href}`);
