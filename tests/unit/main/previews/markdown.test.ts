import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { expect, test, vi } from "vitest";
import { markdownAsset, markdownPage } from "../../../../src/main/previews/markdown";
import { segmentsFor } from "../../../../src/main/previews/policy";

test("embeds arbitrary source as inert JSON without closing the script", () => {
  const source = "</script><script>window.__pwned=true</script>\n<&\u2028";
  const html = markdownPage(source);
  const document = new JSDOM(html).window.document;
  expect(document.scripts).toHaveLength(2);
  expect(document.getElementById("source")?.textContent).not.toContain("<");
  expect(JSON.parse(document.getElementById("source")?.textContent ?? "")).toBe(source);
  expect(document.querySelector("script[src]")?.getAttribute("src")).toBe("/__foom__/markdown.js");
});

test("serves only exact bundled preview assets and reserves their namespace", () => {
  const read = vi.spyOn(fs, "readFileSync").mockReturnValue(Buffer.from("bundle"));
  for (const name of ["markdown.js", "markdown.css", "geist.ttf", "geist-mono.ttf"]) {
    const asset = markdownAsset(`foom-preview://id/__foom__/${name}`, "foom-preview://id");
    expect(asset?.body.toString()).toBe("bundle");
    expect(read.mock.lastCall?.[0]).toBe(path.resolve("src/preview", name));
  }
  for (const url of [
    "foom-preview://other/__foom__/markdown.js",
    "foom-preview://id/__foom__/other.js",
    "foom-preview://id/__foom__/%6darkdown.js",
  ]) {
    expect(markdownAsset(url, "foom-preview://id")).toBeUndefined();
  }
  for (const name of ["__foom__", "%5f_foom__", "__FOOM__"]) {
    expect(segmentsFor(`/assets/${name}/markdown.js`)).toEqual({ error: "reserved" });
  }
});
