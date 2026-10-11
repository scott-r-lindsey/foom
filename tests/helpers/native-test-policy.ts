// Windows run 38104401476 exhausted 5s scenarios and a 10s cold CIM cleanup;
// pre-#215 run 38074707195 took 0.6–1.9s per scenario including cleanup.
// Scale harness deadlines together, never the observer's real 3s hook budget.
export function nativeDeadline(milliseconds: number): number {
  return milliseconds * (process.platform === "win32" ? 3 : 1);
}
