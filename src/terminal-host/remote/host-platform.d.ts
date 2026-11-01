/** Daemon-local observations. Raw OS output never enters the host protocol. */
export interface HostPlatform {
  memoryAvailable(signal?: AbortSignal): Promise<number>;
  processIdentity(
    executable: string,
    signal?: AbortSignal,
  ): Promise<{ pid: number; started: string } | undefined>;
}
