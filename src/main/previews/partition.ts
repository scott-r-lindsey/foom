import { app, session, WebContentsView } from "electron";
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
export function navigationAllowed(url: string, origin: string): boolean {
  const parsed = pathnameFor(url, origin);
  return "pathname" in parsed && /\.(md|markdown)$/i.test(parsed.pathname);
}

/** An isolated, capability-denying partition serving only the captured root. */
export function createPartition(
  record: PreviewRecord,
  root: CanonicalRoot,
  watcher: PreviewWatcher,
) {
  const origin = `foom-preview://${record.id}`;
  const partition = session.fromPartition(`preview-${record.id}`, { cache: false });
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
    const result = await readPreview(
      root,
      request.url,
      origin,
      (file) => {
        watcher.record(file);
      },
      record.network,
    );
    if (result.status === 200 && result.type.startsWith("text/markdown")) {
      return new Response(markdownPage(result.body.toString("utf8")), {
        headers: {
          ...result.headers,
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": previewCsp(result.type, record.network),
        },
      });
    }
    return new Response(
      result.status === 200
        ? new Uint8Array(result.body)
        : result.status === 404
          ? "File not found. Waiting for it to appear."
          : "Preview file unavailable",
      {
        status: result.status,
        headers: result.headers,
      },
    );
  });
  return partition;
}

export function createPreviewView(partition: Electron.Session) {
  const view = new WebContentsView({
    webPreferences: {
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
    },
  });
  return view;
}
