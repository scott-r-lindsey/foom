import { createCommands, displayShortcut } from "./commands";

/** Build-time projection; no executable page script or duplicate shortcut list. */
export function manualShortcuts(): string {
  return (["darwin", "linux"] as const)
    .map((platform) => {
      const commands = createCommands(platform, false, {
        board: () => undefined,
        native: () => undefined,
        zoom: () => Promise.resolve(),
      });
      const rows = commands
        .filter((command) => command.bindings.length > 0)
        .map(
          (command) =>
            `<tr data-command="${command.id}"><td>${command.label}</td><td>${command.bindings.map((binding) => displayShortcut(binding, platform === "darwin")).join(" / ")}</td></tr>`,
        )
        .join("");
      return `<h3>${platform === "darwin" ? "macOS" : "Windows / Linux"}</h3><table data-platform="${platform}"><thead><tr><th>Command</th><th>Shortcut</th></tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join("\n");
}
