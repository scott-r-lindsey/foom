// Source for fixture CLIs only: query before starting any application work.
// Raw mode disables PTY echo/canonical buffering for the OSC replies.
function colorQueryFixture(record, perShell = false) {
  const destination = JSON.stringify(record) + (perShell ? ' + "." + process.ppid' : "");
  return `
process.stdin.setRawMode(true);
process.stdout.write('\\x1b]10;?\\x07\\x1b]11;?\\x07');
await new Promise(resolve => {
  let replies = '';
  const receive = bytes => {
    replies += bytes.toString();
    if (!/\\x1b\\]10;rgb:[0-9a-f/]+\\x1b\\\\/i.test(replies) ||
        !/\\x1b\\]11;rgb:[0-9a-f/]+\\x1b\\\\/i.test(replies)) return;
    process.stdin.off('data', receive);
    require('node:fs').writeFileSync(${destination} + ".tmp", JSON.stringify(replies));
    require('node:fs').renameSync(${destination} + ".tmp", ${destination});
    process.stdin.setRawMode(false);
    process.stdin.pause();
    resolve();
  };
  process.stdin.on('data', receive);
});
`;
}
function oscColor(index, hex) {
  return `\x1b]${index};rgb:${hex
    .slice(1)
    .match(/../g)
    .map((part) => part.repeat(2))
    .join("/")}\x1b\\`;
}
module.exports = { colorQueryFixture, oscColor };
