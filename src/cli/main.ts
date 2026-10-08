import { run } from "./cli";

declare const FOOM_VERSION: string;
const result = run(process.argv.slice(2), FOOM_VERSION);
(result.error ? process.stderr : process.stdout).write(
  `${typeof result.output === "string" ? result.output : JSON.stringify(result.output)}\n`,
);
process.exitCode = result.code;
