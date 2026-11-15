/** Publish fixture records atomically; readers must never observe a replacement prefix.
 * @param {string} file
 * @param {unknown} value
 */
function publishJson(file, value) {
  const { writeFileSync, renameSync } = require("node:fs");
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, file);
}
module.exports = { publishJson };
