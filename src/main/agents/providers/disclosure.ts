import type { DialogContent } from "../../../shared/confirmation";
import type { AgentPluginManifest } from "../../../shared/agent-plugin";

/** Every execution-affecting field is rendered as inert text in the trusted window. */
export function pluginDisclosure(manifest: AgentPluginManifest): DialogContent {
  return {
    title: `Allow ${manifest.name} agent plugin?`,
    glyph: "shield",
    subject: "Future launches from Foom",
    accept: "Allow plugin",
    detail:
      "This plugin chooses what Foom executes as you. A worktree is not a sandbox. Bypass arguments can let the agent act anywhere on this machine. Changes require your approval again; running sessions retain their launch settings.",
    sections: [
      { label: "Identity", items: [manifest.id, manifest.name, manifest.badge] },
      {
        label: "Executable names (resolved on PATH)",
        arguments: true,
        items: manifest.executables,
      },
      { label: "Discovery probes", arguments: true, items: ["--version", "--help"] },
      ...Object.entries(manifest.launch).map(([label, values]) => ({
        label: `Launch ${label}`,
        arguments: true,
        items: values.length ? values : ["(none)"],
      })),
      {
        label: "Bypass arguments",
        arguments: true,
        items: manifest.bypassArguments.length
          ? manifest.bypassArguments
          : ["(none declared; other flags may still bypass approvals)"],
      },
      {
        label: "Hook mapping",
        arguments: true,
        items: manifest.attention.hook ? [JSON.stringify(manifest.attention.hook)] : ["(none)"],
      },
      { label: "Detection rules", arguments: true, items: [JSON.stringify(manifest.attention)] },
      {
        label: "Discovery requirements",
        arguments: true,
        items: [JSON.stringify(manifest.discovery)],
      },
    ],
  };
}
