import { IMAGE_CSP, imagePage, validImage } from "./image";
import { app, session, WebContentsView, type WebPreferences } from "electron";
import type { PreviewRecord } from "../../shared/previews";
import { readPreview, type CanonicalRoot } from "./contained-files";
import { pathnameFor, previewCsp, responseHeaders } from "./policy";
import { markdownAsset, markdownPage } from "./markdown";
import type { PreviewWatcher } from "./watcher";

export function requestAllowed(url: string, origin: string, network = false): boolean {
  return (
    (network && /^(https|wss):/.test(url)) ||
    /^(data|blob):/.test(url) ||
    "pathname" in pathnameFor(url, origin)
  );
}
const IMAGE_ENTRY = /\.(png|jpe?g|webp)$/i;
const RASTER_TYPE = /^image\/(png|jpeg|webp)$/;

export function navigationAllowed(url: string, origin: string, mainFrame = true): boolean {
  const parsed = pathnameFor(url, origin);
  return (
    "pathname" in parsed &&
    (/\.(md|markdown|html|htm)$/i.test(parsed.pathname) ||
      (mainFrame && IMAGE_ENTRY.test(parsed.pathname)))
  );
}

/** Refusals render a local, inert page; paths are text, never markup. */
export function unavailablePage(url: string, origin: string, missing: boolean): string {
  const parsed = pathnameFor(url, origin);
  const pathname = "pathname" in parsed ? parsed.pathname.slice(1) : "";
  let relativePath = pathname;
  try {
    relativePath = decodeURIComponent(pathname);
  } catch {
    /* Keep malformed escapes inert. */
  }
  const escaped = relativePath.replace(
    /[&<>"']/g,
    (character) => `&#${String(character.charCodeAt(0))};`,
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Preview unavailable</title><link rel="stylesheet" href="/__foom__/markdown.css"></head><body><main id="content"><h1>${missing ? "File not found" : "File unavailable"}</h1><p><code>${escaped}</code></p><p>${missing ? "File not found. Waiting for it to appear." : "This file could not be opened."}</p><p>Use Back in the tile header to return to the previous page.</p></main></body></html>`;
}

/** An isolated, capability-denying partition serving only the captured root. */
export function createPartition(
  record: PreviewRecord,
  root: CanonicalRoot,
  watcher?: PreviewWatcher,
) {
  const origin = `foom-preview://${record.id}`;
  const partition = session.fromPartition(`preview-${record.id}`, { cache: false });
  let documentPath: string | undefined;
  const setDocumentUrl = (url: string) => {
    const parsed = pathnameFor(url, origin);
    documentPath = "pathname" in parsed ? parsed.pathname : undefined;
  };
  partition.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  partition.setPermissionCheckHandler(() => false);
  partition.setDevicePermissionHandler(() => false);
  partition.on("will-download", (event) => {
    event.preventDefault();
  });
  partition.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !requestAllowed(details.url, origin, record.network) });
  });
  partition.protocol.handle("foom-preview", async (request) => {
    const asset = markdownAsset(request.url, origin);
    if (asset)
      return new Response(new Uint8Array(asset.body), { headers: responseHeaders(asset.type) });
    // Main selects the document for each native generation. Its raster response
    // is a page, while images embedded in other documents remain ordinary assets.
    const parsed = pathnameFor(request.url, origin);
    const isDocument = "pathname" in parsed && parsed.pathname === documentPath;
    const result = await readPreview(
      root,
      request.url,
      origin,
      watcher?.recorder(),
      record.network,
    );
    if (
      result.status === 200 &&
      isDocument &&
      (IMAGE_ENTRY.test(parsed.pathname) || RASTER_TYPE.test(result.type))
    ) {
      const valid = RASTER_TYPE.test(result.type) && (await validImage(result.body, result.type));
      return new Response(
        valid
          ? imagePage(result.body, result.type)
          : "Invalid or oversized image. PNG, JPEG and WebP only (16 MiB, 16 million pixels).",
        {
          status: valid ? 200 : 400,
          headers: {
            ...result.headers,
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": IMAGE_CSP,
          },
        },
      );
    }
    if (result.status === 200 && result.type.startsWith("text/markdown")) {
      return new Response(markdownPage(result.body.toString("utf8")), {
        headers: {
          ...result.headers,
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": previewCsp(result.type, record.network),
        },
      });
    }
    if (result.status === 200 && (!isDocument || result.type.startsWith("text/html")))
      return new Response(new Uint8Array(result.body), { headers: result.headers });
    return new Response(unavailablePage(request.url, origin, result.status === 404), {
      status: result.status === 200 ? 403 : result.status,
      headers: { ...responseHeaders("text/markdown"), "content-type": "text/html; charset=utf-8" },
    });
  });
  return { partition, setDocumentUrl };
}

export function previewPreferences(partition: Electron.Session): WebPreferences {
  return {
    session: partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    disableDialogs: true,
    navigateOnDragDrop: false,
    webviewTag: false,
    devTools: !app.isPackaged,
    spellcheck: false,
  };
}

export function createPreviewView(partition: Electron.Session) {
  return new WebContentsView({ webPreferences: previewPreferences(partition) });
}
