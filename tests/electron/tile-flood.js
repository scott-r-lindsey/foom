// Bounded load for the manual packaged six-tile measurement.
const line = "flood " + "0123456789".repeat(7) + "\r\n";
let bytes = 0;
const timer = setInterval(() => {
  const chunk = line.repeat(100);
  bytes += chunk.length;
  process.stdout.write(chunk);
}, 20);
setTimeout(() => {
  clearInterval(timer);
  process.stdout.write(`\r\nFLOOD_DONE ${bytes}\r\n`);
}, 12000);
