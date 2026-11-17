import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

test("measurement URLs expand Windows short paths without allowing other files", () => {
  const exports: {
    canonicalFileURL?: (file: string) => string;
    requestFileURL?: (value: string) => string | null;
  } = {};
  const module = { exports };
  const canonicalRoot = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\fixture space";
  const shortRoot = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\fixture space";
  const files = new Set([`${canonicalRoot}\\view.html`, `${canonicalRoot}\\view.js`]);
  runInNewContext(
    readFileSync(new URL("../electron/sqlite-measurement-files.js", import.meta.url), "utf8"),
    {
      module,
      URL,
      require(name: string) {
        if (name === "node:fs")
          return {
            realpathSync: {
              native(file: string) {
                const expanded = file.replace(/RUNNER~1/gi, "runneradmin");
                const canonical = [...files].find(
                  (candidate) => candidate.toLowerCase() === expanded.toLowerCase(),
                );
                if (!canonical) throw Error("Missing fixture file");
                return canonical;
              },
            },
          };
        if (name === "node:url")
          return {
            fileURLToPath: (url: URL) => fileURLToPath(url, { windows: true }),
            pathToFileURL: (file: string) => pathToFileURL(file, { windows: true }),
          };
        throw Error(`Unexpected module: ${name}`);
      },
    },
  );
  const { canonicalFileURL, requestFileURL } = module.exports;
  if (!canonicalFileURL || !requestFileURL) throw Error("Missing fixture URL helpers");
  const page = canonicalFileURL(`${shortRoot}\\view.html`);
  const allowed = new Set([page, canonicalFileURL(`${shortRoot}\\view.js`)]);
  for (const root of [shortRoot, canonicalRoot, canonicalRoot.toUpperCase()]) {
    for (const file of ["view.html", "view.js"]) {
      const url = pathToFileURL(`${root}\\${file}`, { windows: true }).href;
      expect(allowed.has(requestFileURL(url) ?? "")).toBe(true);
    }
  }
  expect(requestFileURL(page)).toBe(page);
  for (const url of [
    `${page}?query`,
    `${page}#fragment`,
    page.replace("view.html", "preload.js"),
    page.replace("fixture%20space", "fixture-other"),
    page.replace("view.html", "%ZZ"),
    "https://example.com/view.html",
    "invalid URL",
  ]) {
    expect(allowed.has(requestFileURL(url) ?? "")).toBe(false);
  }
});
