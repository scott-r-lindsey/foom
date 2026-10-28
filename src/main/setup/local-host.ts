import { cpus, freemem, loadavg, totalmem } from "node:os";
import { readFile } from "node:fs/promises";
import { readLoginShell } from "../login-shell";

/** An on-demand observation, with the same available-memory definition as SSH hosts. */
export async function localResources() {
  let available = freemem();
  if (process.platform === "linux") {
    const match = /^MemAvailable:\s+(\d+) kB$/mu.exec(await readFile("/proc/meminfo", "utf8"));
    if (!match?.[1]) throw new Error("Memory unavailable");
    available = Number(match[1]) * 1024;
  } else if (process.platform === "darwin") {
    const { stdout } = await readLoginShell("/usr/bin/vm_stat", [], {
      cwd: "/",
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 65536,
    });
    const page = /page size of (\d+) bytes/u.exec(stdout)?.[1];
    if (!page) throw new Error("Memory unavailable");
    available = 0;
    for (const name of ["free", "inactive", "speculative"]) {
      const count = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, "mu").exec(stdout)?.[1];
      if (!count) throw new Error("Memory unavailable");
      available += Number(count) * Number(page);
    }
  }
  return {
    cores: cpus().length,
    load: loadavg(),
    memoryTotal: totalmem(),
    memoryAvailable: Math.min(totalmem(), available),
  };
}
