const { writeFileSync } = require("node:fs");

// Real raw-mode PTY probe. A second reply is a failure, just like a missing reply.
process.stdin.setRawMode(true);
process.stdin.resume();
let received = "";
process.stdin.on("data", (data) => {
  received += data.toString();
});
const osc = (code, data) => `\x1b]${code};${data}\x1b\\`;
let expected = "\x1b[1;1R";
let query = "\x1b[H\x1b[6n";
if (process.argv[2] === "colors") {
  const background =
    process.argv[3] === "dracula"
      ? "rgb:2828/2a2a/3636"
      : process.argv[3] === "dark"
        ? "rgb:0505/0404/0a0a"
        : "rgb:f3f3/f0f0/fafa";
  query +=
    osc(10, "?") +
    osc(11, "?") +
    osc(4, "1;#123456;1;?;255;?") +
    osc(10, "#112233;#445566;#778899") +
    osc(10, "?;?;?") +
    osc(104, "") +
    osc(110, "") +
    osc(111, "") +
    osc(112, "") +
    osc(11, "?");
  expected +=
    osc(
      10,
      process.argv[3] === "dracula"
        ? "rgb:f8f8/f8f8/f2f2"
        : process.argv[3] === "dark"
          ? "rgb:f4f4/efef/ffff"
          : "rgb:1414/1010/1f1f",
    ) +
    osc(11, background) +
    osc(4, "1;rgb:1212/3434/5656") +
    osc(4, "255;rgb:eeee/eeee/eeee") +
    osc(10, "rgb:1111/2222/3333") +
    osc(11, "rgb:4444/5555/6666") +
    osc(12, "rgb:7777/8888/9999") +
    osc(11, background);
}
process.stdout.write(query);
setTimeout(() => {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  const valid = received === expected;
  process.stdout.write(`\r\nPROTOCOL_${valid ? "OK" : "FAIL"}${process.argv[4] || ""}\r\n`, () => {
    if (process.argv[5]) writeFileSync(process.argv[5], valid ? "OK" : "FAIL");
    process.exit(valid ? 0 : 1);
  });
}, 500);
