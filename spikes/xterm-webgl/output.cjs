// Deterministic PTY output, including scrollback, without any external process.
const label = process.argv[2] || "fixture";
if (label === "visual") {
  process.stdout.write("VISUAL_IDLE\r\n");
  process.stdin.resume();
} else
  for (let index = 0; index < 200; index++)
    process.stdout.write(`${label} ${String(index).padStart(3, "0")} \x1b[32mgreen\x1b[0m\r\n`);
if (label !== "visual") process.stdout.write(`${label}_DONE\r\n`);
