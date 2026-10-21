import { displayShortcut } from "./commands";
import type { Command } from "./commands";

/** Pure build-time projection; the build supplies the production registry. */
export function manualShortcuts(commands: readonly Command[], platform: string): string {
  const rows = commands
    .filter((command) => command.bindings.length > 0)
    .map(
      (command) =>
        `<tr data-command="${command.id}"><td>${command.label}</td><td>${command.bindings.map((binding) => displayShortcut(binding, platform === "darwin")).join(" / ")}</td></tr>`,
    )
    .join("");
  return `<h3>${platform === "darwin" ? "macOS" : "Windows / Linux"}</h3><table data-platform="${platform}"><thead><tr><th>Command</th><th>Shortcut</th></tr></thead><tbody>${rows}</tbody></table>`;
}
