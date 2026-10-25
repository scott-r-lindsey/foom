import type { BrowserWindow, WebContents, WebContentsView, Session } from "electron";
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { HostedPreview } from "../../../../src/main/previews/hosted-preview";

export function ownerFixture() {
  const contents = () =>
    Object.assign(new EventEmitter(), {
      isDestroyed: vi.fn(() => false),
      isFocused: vi.fn(() => false),
      focus: vi.fn(),
      executeJavaScript: vi.fn(async () => {}),
      send: vi.fn(),
      capturePage: vi.fn(() =>
        Promise.resolve({ isEmpty: () => false, toDataURL: (): string => "pixels" }),
      ),
    });
  const board = contents();
  const window = Object.assign(new EventEmitter(), {
    webContents: board,
    isFocused: vi.fn(() => true),
  });
  const native = contents();
  const entry: HostedPreview = {
    id: "preview",
    view: { webContents: native } as unknown as WebContentsView,
    partition: {} as Session,
    bounds: { x: 0, y: 0, width: 100, height: 100, visible: true },
    loaded: true,
    attached: true,
  };
  const entries = new Map([[entry.id, entry]]);
  return {
    board,
    native,
    window,
    entry,
    entries,
    webContents: board as unknown as WebContents,
    browserWindow: window as unknown as BrowserWindow,
  };
}
