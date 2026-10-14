import fs from "node:fs";
import path from "node:path";
import { pathnameFor } from "./policy";

const assets = new Map([
  ["/__foom__/markdown.js", "text/javascript; charset=utf-8"],
  ["/__foom__/markdown.css", "text/css; charset=utf-8"],
  ["/__foom__/geist.ttf", "font/ttf"],
  ["/__foom__/geist-mono.ttf", "font/ttf"],
]);

/** Only called by the isolated preview session handler, never the board protocol. */
export function markdownAsset(
  url: string,
  origin: string,
): { body: Buffer; type: string } | undefined {
  const parsed = pathnameFor(url, origin);
  if (!("pathname" in parsed)) return;
  const type = assets.get(parsed.pathname);
  if (!type) return;
  return {
    body: fs.readFileSync(path.join(__dirname, "../../preview", path.basename(parsed.pathname))),
    type,
  };
}

export function markdownPage(source: string): string {
  const json = JSON.stringify(source).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Markdown preview</title><link rel="stylesheet" href="/__foom__/markdown.css"></head><body><main id="content"></main><script id="source" type="application/json">${json}</script><script src="/__foom__/markdown.js"></script></body></html>`;
}
