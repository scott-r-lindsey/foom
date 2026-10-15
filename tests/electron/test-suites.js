const { readdirSync } = require("node:fs");
const path = require("node:path");

// Keep execution and registration audits on the same complete suite inventory.
function suiteFiles(directory = __dirname) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => path.join(directory, name));
}

module.exports = { suiteFiles };
