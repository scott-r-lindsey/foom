import type { PreviewSummary } from "../../shared/workspace";
import { Highlight } from "./text-highlight";
export interface SidebarPreviewRowProps {
  preview: PreviewSummary;
  opener: string;
  tile: { number: number; focused: boolean } | undefined;
  filter: string;
  open: (id: string) => void;
}
export function SidebarPreviewRow({ preview, opener, tile, filter, open }: SidebarPreviewRowProps) {
  return (
    <div
      role="treeitem"
      aria-label={`${preview.kind === "markdown" ? "Markdown" : "HTML"} preview: ${preview.relativePath}${preview.openedBy ? `, opened by ${opener}` : ""}${tile !== undefined ? "" : ", not shown"}`}
    >
      <button
        type="button"
        data-nav
        className="tree-row preview-row"
        data-child={Boolean(preview.openedBy)}
        onClick={() => {
          open(preview.id);
        }}
      >
        <svg className="preview-glyph" aria-hidden="true" viewBox="0 0 16 16">
          <path d="M4 1.5h5l3 3v10H4z M9 1.5v3h3 M6 8h4 M6 10.5h4" />
        </svg>
        <span className="tree-label">
          <Highlight text={preview.relativePath} filter={filter} />
          {preview.openedBy && <span className="preview-row-opener">opened by {opener}</span>}
        </span>
        {tile !== undefined && (
          <span
            className="tile-number"
            data-focused={tile.focused}
            aria-label={`Tile ${String(tile.number)}`}
          >
            {tile.number}
          </span>
        )}
      </button>
    </div>
  );
}
