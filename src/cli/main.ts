import { execute } from "./execute";
declare const FOOM_VERSION: string;
void execute(
  process.argv.slice(2),
  FOOM_VERSION,
  {
    out: (text) => {
      process.stdout.write(text);
    },
    error: (text) => {
      process.stderr.write(text);
    },
    input: process.stdin,
  },
  process.env,
  process.execPath,
).then((code) => {
  process.exitCode = code;
});
