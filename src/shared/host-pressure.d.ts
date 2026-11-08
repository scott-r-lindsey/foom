/** Numeric host facts only; no paths, process identities or output. */
export interface HostResources {
  cores: number;
  load: number[];
  memoryTotal: number;
  memoryAvailable: number;
}
export type HostPressure =
  | { measured: false }
  | {
      measured: true;
      loadPerCore: number;
      memoryAvailable: number;
      memoryTotal: number;
      sessions: number;
      reservations: number;
      budget: number;
    };
