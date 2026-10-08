import { app, Menu, nativeImage } from "electron";
import type { BrowserWindow } from "electron";
import type { Command } from "./commands";
import type { WorkspaceSnapshot } from "../../shared/workspace";

const digits = [
  "111101101101111",
  "010110010010111",
  "111001111100111",
  "111001111001111",
  "101101111001001",
  "111100111001111",
  "111100111101111",
  "111001001001001",
  "111101111101111",
  "111101111001111",
];
/** Small BGRA bitmap, with a legible count; no filesystem or renderer image input. */
export function badgePixels(count: number): Buffer {
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      if ((x - 15.5) ** 2 + (y - 15.5) ** 2 > 15.5 ** 2) continue;
      const offset = (y * 32 + x) * 4;
      pixels.set([62, 178, 255, 255], offset);
    }
  const text = String(Math.min(count, 99));
  const left = text.length === 1 ? 13 : 9;
  for (let index = 0; index < text.length; index++) {
    const glyph = digits[Number(text[index])];
    if (!glyph) continue;
    for (let cell = 0; cell < 15; cell++)
      if (glyph[cell] === "1") {
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++)
            pixels.set(
              [31, 16, 20, 255],
              ((11 + Math.floor(cell / 3) * 2 + dy) * 32 + left + index * 8 + (cell % 3) * 2 + dx) *
                4,
            );
      }
  }
  return pixels;
}
export function updateAttention(
  window: BrowserWindow,
  snapshot: WorkspaceSnapshot,
  newWindow: Command,
) {
  const waiting = snapshot.terminals.filter((terminal) => terminal.state?.state === "needs_input");
  const count = waiting.length;
  if (process.platform === "win32")
    window.setOverlayIcon(
      count ? nativeImage.createFromBitmap(badgePixels(count), { width: 32, height: 32 }) : null,
      count ? `${String(count)} ${count === 1 ? "session needs" : "sessions need"} you` : "",
    );
  else if (process.platform === "darwin") {
    app.dock?.setBadge(count ? String(count) : "");
    app.dock?.setMenu(
      Menu.buildFromTemplate([
        {
          id: newWindow.id,
          label: newWindow.label,
          enabled: newWindow.enabled,
          click: newWindow.run,
        },
        ...waiting.map((terminal) => ({
          label: `${terminal.agent} · ${terminal.branch ?? terminal.worktree}`,
          click: () => {
            if (window.isMinimized()) window.restore();
            window.show();
            window.focus();
            window.webContents.send("app-menu:session", terminal.id);
          },
        })),
      ]),
    );
  } else app.setBadgeCount(count);
}
