import type { PreviewApi, PreviewSnapshot } from "../../shared/previews";

/** Native views cannot participate in DOM stacking. Freeze them while board UI
 * covers the tiles, including the entire drag (before a drop target exists). */
export function attachPreviewComposition(api: PreviewApi): () => void {
  const images = new Map<string, HTMLCanvasElement>();
  const decoded = new WeakMap<HTMLCanvasElement, string>();
  let disposed = false;
  let covered = false;
  let frame = 0;
  const draw = (snapshots: readonly PreviewSnapshot[]) => {
    const retained = new Set(snapshots.map(({ id }) => id));
    for (const [id, image] of images) {
      if (!retained.has(id)) {
        image.remove();
        images.delete(id);
      }
    }
    for (const snapshot of snapshots) {
      let image = images.get(snapshot.id);
      if (!image) {
        image = document.createElement("canvas");
        image.className = "preview-snapshot";
        image.setAttribute("aria-hidden", "true");
        image.dataset["preview"] = snapshot.id;
        document.body.append(image);
        images.set(snapshot.id, image);
      }
      const canvas = image;
      if (decoded.get(canvas) !== snapshot.image) {
        decoded.set(canvas, snapshot.image);
        const bytes = Uint8Array.from(
          atob(snapshot.image.slice("data:image/png;base64,".length)),
          (character) => character.charCodeAt(0),
        );
        void createImageBitmap(new Blob([bytes], { type: "image/png" }))
          .then((bitmap) => {
            if (
              !disposed &&
              images.get(snapshot.id) === canvas &&
              decoded.get(canvas) === snapshot.image
            ) {
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
              canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
            }
            bitmap.close();
          })
          .catch(() => {});
      }
      const { x, y, width, height } = snapshot.bounds;
      Object.assign(image.style, {
        left: `${String(x)}px`,
        top: `${String(y)}px`,
        width: `${String(width)}px`,
        height: `${String(height)}px`,
      });
    }
  };
  const off = api.onSnapshots((snapshots) => {
    draw(snapshots);
    position();
  });
  const position = () => {
    for (const [id, image] of images) {
      const tile = document.querySelector(`[data-preview-id="${id}"]`);
      if (!tile) continue;
      const rect = tile.getBoundingClientRect();
      const title = tile.querySelector(".tile-title")?.getBoundingClientRect();
      const top = title?.bottom ?? rect.top;
      Object.assign(image.style, {
        left: `${String(rect.left + 4)}px`,
        top: `${String(top)}px`,
        width: `${String(Math.max(0, rect.width - 8))}px`,
        height: `${String(Math.max(0, rect.bottom - top - 4))}px`,
        opacity: getComputedStyle(tile).opacity,
      });
    }
  };
  const update = () => {
    if (disposed) return;
    const moving = document
      .getAnimations()
      .some(
        (animation) =>
          animation.effect instanceof KeyframeEffect &&
          animation.effect.target instanceof Element &&
          animation.effect.target.matches(".terminal-tile") &&
          animation.playState !== "finished" &&
          animation.playState !== "idle",
      );
    const next =
      moving ||
      Boolean(
        document.querySelector(
          '.row-menu, .wordmark-menu[aria-expanded="true"], .board-confirmation-scrim, dialog[open], .board-home[data-dragging="true"], .board-home[data-preview-covered="true"]',
        ),
      );
    if (next !== covered) {
      covered = next;
      void api.cover(next).catch(() => {});
    }
    position();
    // Follow real animation completion, including cancellation/reduced motion.
    if (moving && !frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
  };
  const observer = new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          !(record.target instanceof Element) || !record.target.matches(".preview-snapshot"),
      )
    )
      update();
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      "data-maximized",
      "data-behind",
      "data-dragging",
      "data-preview-covered",
      "style",
      "open",
      "aria-expanded",
    ],
  });
  update();
  return () => {
    disposed = true;
    observer.disconnect();
    cancelAnimationFrame(frame);
    off();
    draw([]);
    void api.cover(false).catch(() => {});
  };
}
