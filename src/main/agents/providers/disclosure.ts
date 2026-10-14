import type { AgentManifestV2 } from "../../../shared/agent-manifest-v2";
import { CHILD_PROMPT, CONFIG_PROMPT, CLI_GUIDANCE } from "./cli-launch";
import type { DialogContent } from "../../../shared/confirmation";
import type { AgentPluginManifest } from "../../../shared/agent-plugin";

/** Every execution-affecting field is rendered as inert text in the trusted window. */
export function pluginDisclosure(
  manifest: AgentPluginManifest | AgentManifestV2,
  review?: { file: string; digest: string; text: string; previous: string | null },
): DialogContent {
  if (manifest.version === 2)
    return {
      title: `Allow ${manifest.name} agent plugin?`,
      glyph: "shield",
      subject: "Future launches from Foom",
      accept: "Allow plugin",
      detail:
        "This config plugin chooses what Foom executes as you. A worktree is not a sandbox. Approval grants no orchestration role or tool approval. Bypass consent is separate. No global agent configuration is written. Edits revoke future launch authority; running sessions retain their launch settings.",
      sections: [
        {
          label: "Identity and config provenance",
          items: [
            manifest.id,
            manifest.name,
            manifest.badge,
            review?.file ?? `agents/${manifest.id}.json`,
            review?.digest ?? "(no digest)",
          ],
        },
        {
          label: "Executable resolution and probes",
          arguments: true,
          items: [
            ...manifest.executables,
            "Absolute login PATH entries only; native executables on Windows; no resolved path before approval",
            "--version",
            "--help",
          ],
        },
        ...Object.entries(manifest).map(([key, value]) => ({
          label: key,
          arguments: true,
          items: [value === undefined ? "(none)" : JSON.stringify(value)],
        })),
        {
          label: "Foom prompt composition (one argv value; no recursive substitution)",
          arguments: true,
          items: [
            CHILD_PROMPT,
            CONFIG_PROMPT,
            CLI_GUIDANCE,
            "Guidance collects user aliases in order, then appends Foom text with two newlines; config resume has no greeting. Preview grants apply only to the random attached MCP server.",
          ],
        },
        {
          label: "Previous approved bytes (JSON-escaped)",
          arguments: true,
          items: [
            review?.previous === null || review?.previous === undefined
              ? "(none)"
              : JSON.stringify(review.previous),
          ],
        },
        {
          label: "Proposed exact bytes (JSON-escaped)",
          arguments: true,
          items: [JSON.stringify(review?.text ?? manifest)],
        },
        ...(manifest.hooks?.channels
          .filter((channel) => channel.disclosure)
          .map((channel) => ({
            label: `Channel acknowledgement: ${channel.disclosure?.id ?? channel.id}`,
            items: [
              channel.disclosure?.text ?? "",
              "Allow plugin acknowledges this disclosure for these exact manifest bytes in this profile.",
            ],
          })) ?? []),
        {
          label: "Unavailable capabilities",
          items: [
            "Setup actions require a later engine version.",
            "Environment bypass confirmation shows names and predicates only, never values.",
          ],
        },
      ],
    };
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
