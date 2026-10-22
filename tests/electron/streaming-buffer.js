// Bounded fixture output, also imported by the catch-up assertion as its oracle.
function output(stage) {
  let text = stage === "alternate" ? "\x1b[?1049h\x1b[2J\x1b[H" : "";
  for (let index = 0; index < 180; index++)
    text += `${stage}:${String(index).padStart(3, "0")} \x1b[32mgreen\x1b[0m café 界 e\u0301\r\n`;
  return `${text}BUFFER_${stage}_DONE`;
}
if (require.main === module) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[3J\x1b[2J\x1b[HBUFFER_READY");
  process.stdin.on("data", (data) => {
    process.stdout.write(output(data.toString() === "a" ? "alternate" : "normal"));
  });
}
module.exports = { output };
