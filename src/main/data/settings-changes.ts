import type { Settings } from "../../shared/setup";
import type { DataView } from "../../shared/data-views";
import { viewChanges } from "./view-changes";

/** Invalidate dependent projections without probing unrelated Settings tabs. */
export function settingsChanged(before: Settings, after: Settings): void {
  const changed = (keys: readonly (keyof Settings)[]) =>
    keys.some((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  const views: DataView[] = ["settings"];
  if (changed(["registeredHosts", "agents"])) views.push("hosts");
  if (
    changed([
      "registeredHosts",
      "agents",
      "agentArguments",
      "agentHooks",
      "hooks",
      "agentBypassIdentities",
    ])
  )
    views.push("agents");
  if (changed(["forges", "forgeHosts"])) views.push("readiness");
  viewChanges.publish(...views);
}
