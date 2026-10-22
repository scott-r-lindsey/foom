import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DialogContent } from "../../../../src/shared/confirmation";
import type { BrowserWindow } from "electron";
import { afterEach, vi } from "vitest";
const fake = vi.hoisted(() => ({
  views: [] as FakeView[],
  packaged: false,
  external: vi.fn(async (_url: string) => {}),
  nextLoad: undefined as Promise<void> | undefined,
}));
export class FakeSession extends EventEmitter {
  protocol = {
    handle: vi.fn<(scheme: string, handler: (request: { url: string }) => Response) => void>(),
    unhandle: vi.fn(),
  };
  webRequest = {
    onBeforeRequest:
      vi.fn<
        (
          handler:
            | ((details: { url: string }, callback: (value: { cancel: boolean }) => void) => void)
            | null,
        ) => void
      >(),
  };
  setPermissionRequestHandler =
    vi.fn<
      (
        handler: (contents: null, permission: string, callback: (allowed: boolean) => void) => void,
      ) => void
    >();
  setPermissionCheckHandler = vi.fn<(handler: () => boolean) => void>();
  setDevicePermissionHandler = vi.fn<(handler: () => boolean) => void>();
  clearStorageData = vi.fn(async () => {});
  clearCache = vi.fn(async () => {});
  closeAllConnections = vi.fn(async () => {});
}
export class FakeContents extends EventEmitter {
  session = new FakeSession();
  send = vi.fn();
  capturePage = vi.fn(() =>
    Promise.resolve({
      isEmpty: (): boolean => false,
      toDataURL: (): string => "data:image/png;base64,AA==",
    }),
  );
  focus = vi.fn();
  executeJavaScript = vi.fn(async (_script: string) => {});
  isFocused = vi.fn(() => false);
  isDestroyed = vi.fn(() => false);
  setWindowOpenHandler =
    vi.fn<(handler: (details: { url: string }) => { action: string }) => void>();
  getURL = vi.fn(() => "");
  loadURL = vi.fn((url: string) => {
    this.getURL.mockReturnValue(url);
    this.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false });
    const result = fake.nextLoad;
    fake.nextLoad = undefined;
    return result ?? Promise.resolve();
  });
  executeJavaScriptInIsolatedWorld = vi.fn<() => Promise<unknown>>().mockResolvedValue([0, 1200]);
  reload = vi.fn(() => {
    this.emit("did-start-navigation", {
      url: this.getURL(),
      isMainFrame: true,
      isSameDocument: false,
    });
  });
  setZoomFactor = vi.fn();
  getZoomFactor = vi.fn(() => 1);
  close = vi.fn(() => {
    this.isDestroyed.mockReturnValue(true);
  });
}
export class FakeView {
  webContents = new FakeContents();
  setBounds = vi.fn();
  setVisible = vi.fn();
  constructor(readonly options: unknown) {
    fake.views.push(this);
  }
}
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return fake.packaged;
    },
  },
  session: { fromPartition: () => partition },
  WebContentsView: FakeView,
  shell: { openExternal: fake.external },
}));
export let partition: FakeSession;
const { PreviewHost } = await import("../../../../src/main/previews/host");
import { PreviewRegistry } from "../../../../src/main/previews/registry";
const roots: string[] = [];
afterEach(async () => {
  fake.views.splice(0);
  fake.packaged = false;
  fake.external.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
export async function fixture(
  confirm: (content: DialogContent, signal: AbortSignal) => Promise<boolean> = vi.fn(() =>
    Promise.resolve(false),
  ),
  bundled = false,
) {
  const root = await mkdtemp(join(tmpdir(), "foom-host-"));
  roots.push(root);
  await writeFile(join(root, "a.html"), "<input autofocus>");
  const window = Object.assign(new EventEmitter(), {
    webContents: new FakeContents(),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    isFocused: vi.fn(() => false),
    getContentBounds: vi.fn(() => ({ width: 800, height: 600 })),
  });
  partition = new FakeSession();
  const registry = new PreviewRegistry(join(root, "registry.json"));
  const validate = vi.fn(async (_worktree: string) => {});
  const changed = vi.fn();
  const host = new PreviewHost(
    window as unknown as BrowserWindow,
    registry,
    validate,
    changed,
    confirm,
    bundled ? root : undefined,
  );
  const open = async () => {
    const id = await host.open(root, "a.html");
    const view = fake.views.at(-1);
    if (!view) throw new Error("Missing view");
    view.webContents.session = partition;
    return { id, view };
  };
  return { root, window, registry, validate, changed, host, open, confirm };
}

export { fake };
