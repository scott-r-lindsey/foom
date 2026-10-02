// Cross-platform raw input probe: records bytes and enables alternate-screen mouse modes.
const { appendFileSync } = require("node:fs");
const marker = process.argv[2];
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\x1b[?1049h\x1b[2J\x1b[HINPUT_READY");
process.stdin.on("data", (data) => {
  appendFileSync(marker, data.toString("hex") + "\n");
  if (data.toString() === "m") process.stdout.write("\x1b[?1000h\x1b[?1006hMOUSE_READY");
  if (data.toString() === "q") {
    process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?1049l");
    process.exit(0);
  }
});
