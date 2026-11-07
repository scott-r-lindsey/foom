// Runs with the system Node executable inside a real PTY on every platform.
const mode = process.argv[2];
process.stdin.setRawMode(true);
process.stdin.resume();
if (mode === "parser") {
  process.stdout.write("\x1b[10821082\u00a0\r\nPARSER_READY\r\n");
  process.stdin.on("data", (data) => process.stdout.write(data));
} else if (mode === "echo") {
  process.stdout.write("READY\r\n");
  process.stdin.on("data", (data) => process.stdout.write(data));
} else if (mode === "startup") {
  // Fixture CLI startup output, followed by an interactive lifetime.
  void (async () => {
    for (let index = 0; index < 1200; index++) {
      if (!process.stdout.write(`STARTUP_${index}:${"x".repeat(440)}\r\n`))
        await new Promise((resolve) => process.stdout.once("drain", resolve));
    }
    process.stdout.write("STARTUP_READY\r\n");
    process.stdin.on("data", (data) => process.stdout.write(data));
  })();
} else {
  process.stdout.write("READY\r\n");
  process.stdin.once("data", async () => {
    // More than 3 MB, retained within the host's 10,000-line scrollback.
    // Every row has an index so dropped output cannot hide behind a final marker.
    for (let index = 0; index < 8000; index++) {
      const line = `ROW_${String(index).padStart(5, "0")}:${"x".repeat(440)}\r\n`;
      if (!process.stdout.write(line)) {
        await new Promise((resolve) => process.stdout.once("drain", resolve));
      }
    }
    process.stdout.write("FLOOD_END\r\n", () => process.exit(0));
  });
}
