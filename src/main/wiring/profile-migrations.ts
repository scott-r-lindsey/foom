import { realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { verifyPrivate } from "../../node-common/private-files";

/** Retire the #1262 list store without reading retired approvals or toolchain files. */
export async function removeRetiredRepositorySetup(
  profile: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    signal.throwIfAborted();
    const directory = join(await realpath(profile), "repository-setup");
    await verifyPrivate(directory, true);
    const state = join(directory, "state.json");
    await verifyPrivate(state, false);
    // Quit can happen during verification. Only dispatch while the app still owns the profile.
    signal.throwIfAborted();
    await unlink(state);
  } catch (error) {
    if (signal.aborted && error === signal.reason) return;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    console.warn("Unable to retire legacy repository setup state. Cleanup will retry at startup.");
  }
}
