// Bounded, deterministic PTY output for renderer loss and scrollback checks.
const marker = process.argv[2] || "BEFORE";
process.stdout.write(`\r\nWEBGL_${marker}_TOP\r\n`);
for (let index = 0; index < 120; index++)
  process.stdout.write(`WEBGL_${marker}_${String(index).padStart(3, "0")}\r\n`);
process.stdout.write(`WEBGL_${marker}_DONE\r\n`);
