import { describe, expect, test } from "vitest";
import { JSDOM } from "jsdom";
import { createCommands, displayShortcut } from "../../../../src/main/window/commands";
import { manualShortcuts } from "../../../../src/main/window/manual-shortcuts";

describe("bundled manual shortcuts", () => {
  test("every production binding matches the registry on both platform families", () => {
    for (const platform of ["darwin", "linux"]) {
      const commands = createCommands(platform, false, {
        board: () => undefined,
        native: () => undefined,
        zoom: () => Promise.resolve(),
      });
      const document = new JSDOM(manualShortcuts(commands, platform)).window.document;
      const bound = commands.filter((command) => command.bindings.length);
      const rows = document.querySelectorAll(`[data-platform="${platform}"] tbody tr`);
      expect(rows).toHaveLength(bound.length);
      for (const command of bound) {
        const row = document.querySelector(
          `[data-platform="${platform}"] [data-command="${command.id}"]`,
        );
        expect(row?.children[0]?.textContent).toBe(command.label);
        expect(row?.children[1]?.textContent).toBe(
          command.bindings
            .map((binding) => displayShortcut(binding, platform === "darwin"))
            .join(" / "),
        );
      }
    }
  });
});
