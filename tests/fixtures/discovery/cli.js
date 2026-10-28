const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");

const [directory, mode, flag] = process.argv.slice(2);
if (
  mode === "healthy" ||
  (mode !== "descendant" && flag !== (mode === "version" ? "--version" : "--help"))
) {
  console.log(flag === "--version" ? "2.1.284" : "--settings");
} else {
  process.on("SIGTERM", () => {});
  appendFileSync(join(directory, "pids"), `${process.pid}\n`);
  if (mode === "descendant") {
    process.send("ready");
    setInterval(() => {}, 1000);
  } else {
    const child = spawn(process.execPath, [__filename, directory, "descendant"], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.once("message", () => {
      if (mode === "exit") process.exit(0);
      else if (mode === "stdout" || mode === "stderr")
        process[mode].write("x".repeat(256 * 1024 + 1));
    });
    setInterval(() => {}, 1000);
  }
}
