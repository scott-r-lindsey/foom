import { cpus, loadavg, totalmem } from "node:os";
import { daemonHostPlatform } from "./host-platform";

/** Fresh daemon-local facts; never uses management or Settings caches. */
export async function launchResources(signal: AbortSignal) {
  return {
    cores: cpus().length,
    load: loadavg(),
    memoryTotal: totalmem(),
    memoryAvailable: Math.min(totalmem(), await daemonHostPlatform.memoryAvailable(signal)),
  };
}
