import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const capture = vi.hoisted(() => ({
  options: vi.fn<(options: unknown) => void>(),
  open: vi.fn<(handler: () => unknown) => void>(),
  on: vi.fn<(event: string, handler: (...args: unknown[]) => void) => void>(),
  load: vi.fn<(url: string) => Promise<void>>(),
  page: vi.fn<() => Promise<{ isEmpty: () => boolean; toDataURL: () => string }>>(),
  destroy: vi.fn(),
  unhandle: vi.fn(),
  documentUrl: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: class {
    constructor(options: unknown) {
      capture.options(options);
    }
    webContents = {
      setWindowOpenHandler: capture.open,
      on: capture.on,
      loadURL: capture.load,
      capturePage: capture.page,
    };
    isDestroyed = () => false;
    destroy = capture.destroy;
  },
}));
vi.mock("../../../../src/main/previews/partition", () => ({
  createPartition: () => ({
    partition: { protocol: { unhandle: capture.unhandle } },
    setDocumentUrl: capture.documentUrl,
  }),
  previewPreferences: () => ({ sandbox: true, contextIsolation: true }),
}));

import { decisionPreview } from "../../../../src/main/previews/control-backend";

it("captures a contained read-only preview and releases the native window and protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "foom-decision-preview-"));
  try {
    await writeFile(join(root, "preview.html"), "<p>Review this</p>");
    await writeFile(join(root, "refused.html"), "<p>Refused</p>");
    capture.load.mockResolvedValue(undefined);
    capture.page.mockResolvedValue({
      isEmpty: () => false,
      toDataURL: () => "data:image/png;base64,AA==",
    });
    const render = decisionPreview();
    const rendering = render(root, "preview.html");
    expect(await rendering).toBe("data:image/png;base64,AA==");
    expect(capture.options.mock.lastCall?.[0]).toMatchObject({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, javascript: false, offscreen: true },
    });
    expect(capture.open.mock.lastCall?.[0]()).toEqual({ action: "deny" });
    for (const event of ["will-frame-navigate", "will-redirect"]) {
      const preventDefault = vi.fn();
      capture.on.mock.calls.find(([name]) => name === event)?.[1]({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
    expect(capture.load.mock.lastCall?.[0]).toMatch(
      /^foom-preview:\/\/[a-f0-9]{32}\/preview.html$/,
    );
    expect(capture.documentUrl).toHaveBeenCalledWith(capture.load.mock.lastCall?.[0]);
    expect(capture.destroy).toHaveBeenCalledOnce();
    expect(capture.unhandle).toHaveBeenCalledWith("foom-preview");
    expect(await render(root, "missing.html")).toBeNull();
    capture.load.mockImplementationOnce(() => {
      capture.on.mock.calls.findLast(([name]) => name === "did-navigate")?.[1]({}, "", 403);
      return Promise.resolve();
    });
    expect(await render(root, "refused.html")).toBeNull();
    capture.load.mockRejectedValueOnce(new Error("initial load failed"));
    expect(await render(root, "preview.html")).toBeNull();
    capture.page.mockResolvedValueOnce({ isEmpty: () => true, toDataURL: () => "" });
    expect(await render(root, "preview.html")).toBeNull();
    capture.page.mockResolvedValueOnce({
      isEmpty: () => false,
      toDataURL: () => "x".repeat(2 * 1024 * 1024 + 1),
    });
    expect(await render(root, "preview.html")).toBeNull();
    expect(capture.destroy).toHaveBeenCalledTimes(5);
    expect(capture.unhandle).toHaveBeenCalledTimes(5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("waits for a busy capture before rendering the next valid document", async () => {
  const root = await mkdtemp(join(tmpdir(), "foom-decision-preview-"));
  try {
    await writeFile(join(root, "first.html"), "<p>First</p>");
    await writeFile(join(root, "second.html"), "<p>Second</p>");
    const inLoad = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    capture.load.mockResolvedValue(undefined).mockImplementationOnce(() => {
      inLoad.resolve(undefined);
      return release.promise;
    });
    capture.page.mockResolvedValue({
      isEmpty: () => false,
      toDataURL: () => "data:image/png;base64,AA==",
    });
    const render = decisionPreview();
    const first = render(root, "first.html");
    await inLoad.promise;
    const second = render(root, "second.html");
    const others = Array.from({ length: 14 }, () => render(root, "second.html"));
    await expect(render(root, "second.html")).resolves.toBeNull();
    release.resolve(undefined);
    await expect(first).resolves.toMatch(/^data:image\/png/);
    await expect(second).resolves.toMatch(/^data:image\/png/);
    await Promise.all(others);
    expect(capture.load.mock.lastCall?.[0]).toMatch(/\/second.html$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
