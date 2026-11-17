const { realpathSync } = require("node:fs");
const { fileURLToPath, pathToFileURL } = require("node:url");

function canonicalFileURL(file) {
  // Native realpath expands Windows 8.3 aliases as well as normalizing case.
  return pathToFileURL(realpathSync.native(file)).href;
}

function requestFileURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" || url.search || url.hash) return null;
    return canonicalFileURL(fileURLToPath(url));
  } catch {
    // Malformed URLs and missing files never enter the fixture allowlist.
    return null;
  }
}

module.exports = { canonicalFileURL, requestFileURL };
