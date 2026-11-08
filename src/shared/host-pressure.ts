import type { HostPressure, HostResources } from "./host-pressure.d";
import { LaunchFailure } from "./launch-failure";

const GIB = 1024 ** 3;
/** A host-wide reservation spans preparation through publication of the live session. */
export class HostAdmission {
  private pending = 0;

  async reserve(
    measure: () => Promise<HostResources>,
    running: () => number,
  ): Promise<{ pressure: HostPressure; release(): void }> {
    const resources = await measure().catch(() => undefined);
    let pressure: HostPressure = { measured: false };
    if (
      resources &&
      Number.isSafeInteger(resources.cores) &&
      resources.cores > 0 &&
      Number.isFinite(resources.load[0]) &&
      (resources.load[0] ?? -1) >= 0 &&
      Number.isSafeInteger(resources.memoryTotal) &&
      resources.memoryTotal > 0 &&
      Number.isSafeInteger(resources.memoryAvailable) &&
      resources.memoryAvailable >= 0 &&
      resources.memoryAvailable <= resources.memoryTotal
    ) {
      pressure = {
        measured: true,
        loadPerCore: (resources.load[0] ?? 0) / resources.cores,
        memoryAvailable: resources.memoryAvailable,
        memoryTotal: resources.memoryTotal,
        sessions: running(),
        reservations: this.pending,
        budget: Math.max(
          1,
          Math.min(resources.cores, Math.floor(resources.memoryTotal / (4 * GIB))),
        ),
      };
      if (
        pressure.loadPerCore >= 1 ||
        pressure.memoryAvailable < Math.max(GIB, pressure.memoryTotal * 0.1) ||
        pressure.sessions + pressure.reservations >= pressure.budget
      )
        throw new LaunchFailure("host_busy", pressure);
    }
    this.pending++;
    let released = false;
    return {
      pressure,
      release: () => {
        if (!released) this.pending--;
        released = true;
      },
    };
  }
}

export function hostPressure(value: unknown): value is HostPressure {
  if (!value || typeof value !== "object") return false;
  if (!("measured" in value)) return false;
  if (value.measured === false) return Object.keys(value).length === 1;
  if (value.measured !== true) return false;
  const keys = [
    "loadPerCore",
    "memoryAvailable",
    "memoryTotal",
    "sessions",
    "reservations",
    "budget",
  ];
  return (
    Object.keys(value).length === 7 &&
    keys.every((key) => {
      const number: unknown = Reflect.get(value, key);
      return (
        typeof number === "number" &&
        Number.isFinite(number) &&
        number >= 0 &&
        (key === "loadPerCore" || Number.isSafeInteger(number))
      );
    })
  );
}
