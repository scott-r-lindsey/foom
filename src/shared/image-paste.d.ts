/** One explicit clipboard action; no image bytes cross the renderer boundary. */
export type TerminalPaste =
  | { kind: "text"; text: string }
  | { kind: "unsupported" | "empty" | "failed" | "cancelled" };
export interface ImagePut {
  type: "image-put";
  id: string;
  owner: string;
  upload: string;
  size: number;
  sha256: string;
  data: string;
}
export type ImagePutResult = { type: "image-result"; id: string; owner: string; upload: string } & (
  | { ok: true; path: string }
  | { ok: false }
);
