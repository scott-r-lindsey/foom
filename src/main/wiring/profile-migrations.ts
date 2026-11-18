import { realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { verifyPrivate } from "../../node-common/private-files";

/** Retire the #1262 list store without reading retired approvals or toolchain files. */
export async function removeRetiredRepositorySetup(profile: string): Promise<void> {
  try {
    const directory = join(await realpath(profile), "repository-setup");
    await verifyPrivate(directory, true);
    const state = join(directory, "state.json");
    await verifyPrivate(state, false);
    await unlink(state);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    console.warn("Unable to retire legacy repository setup state. Cleanup will retry at startup.");
  }
}
