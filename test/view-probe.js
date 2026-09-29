// A deterministic fullscreen application for the real renderer attachment test.
const { writeFileSync } = require("node:fs");
const marker = process.argv[2];
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\x1b[2J\x1b[HNORMAL_VIEW_READY\r\n");
process.stdin.on("data", (data) => {
  const key = data.toString();
  if (key === "a") {
    process.stdout.write("\x1b[?1049h\x1b[2J\x1b[HALTERNATE_HIDDEN_OUTPUT", () => {
      writeFileSync(marker, "alternate");
    });
  } else if (key === "n") {
    process.stdout.write("\x1b[?1049lNORMAL_HIDDEN_OUTPUT\r\n", () => {
      writeFileSync(marker, "normal");
    });
  } else if (key === "q") {
    process.exit(0);
  }
});
