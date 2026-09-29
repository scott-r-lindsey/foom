// Real raw-mode PTY probe. A second reply is a failure, just like a missing reply.
process.stdin.setRawMode(true);
process.stdin.resume();
let received = "";
process.stdin.on("data", (data) => {
  received += data.toString();
});
process.stdout.write("\x1b[H\x1b[6n");
setTimeout(() => {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  const valid = received === "\x1b[1;1R";
  process.stdout.write(`\r\nPROTOCOL_${valid ? "OK" : "FAIL"}\r\n`, () => {
    process.exit(valid ? 0 : 1);
  });
}, 500);
