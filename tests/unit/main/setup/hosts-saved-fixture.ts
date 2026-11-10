import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { Hosts } from "../../../../src/main/setup/hosts";
import { SettingsStore } from "../../../../src/main/setup/settings";
import type { HostManagement, HostResult } from "../../../../src/shared/registered-hosts.d";

/** A real persisted check followed by a new settings store and Hosts owner. */
export async function restartedBrewHost() {
  const root = await mkdtemp(join(tmpdir(), "hosts-saved-recipes-"));
  const run = vi
    .fn<(host: string, request: HostManagement) => Promise<HostResult>>()
    .mockResolvedValue({
      ok: true,
      facts: {
        codeFolder: "/Users/fixture/foom",
        version: "0.1.0",
        sessions: 0,
        cores: 8,
        load: [0, 0, 0],
        memoryTotal: 8000,
        memoryAvailable: 4000,
        folder: { state: "pass" },
        requirements: {
          distro: "darwin",
          libc: "supported",
          packageManager: "brew",
          mac: { commandLineTools: true, staysAwake: true, protectedFolder: false },
        },
        tools: [
          { id: "git", state: "missing", signIn: "unknown" },
          { id: "gh", state: "ready", signIn: "signed-out" },
        ],
        agents: [{ id: "codex", state: "ready", signIn: "signed-out" }],
      },
    });
  const store = await SettingsStore.open(root);
  await store.update({
    agents: { codex: true },
    registeredHosts: [{ host: "mac-fixture", codeFolder: "/Users/fixture/foom" }],
  });
  const first = new Hosts(store, () => [], "0.1.0", run);
  const checked = await first.action({
    action: "preflight",
    host: "mac-fixture",
    codeFolder: "/Users/fixture/foom",
  });
  first.dispose();
  run.mockClear();
  const reopened = await SettingsStore.open(root);
  const hosts = new Hosts(reopened, () => [], "0.1.0", run, "a".repeat(32));
  return {
    root,
    hosts,
    store: reopened,
    run,
    checked,
    async dispose() {
      hosts.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
