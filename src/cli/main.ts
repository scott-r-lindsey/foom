import { runRepositorySetup } from "../node-common/repository-setup-run";
import { installLocalAgent } from "../node-common/local-agent-install";
import { execute } from "./execute";
declare const FOOM_VERSION: string;
void (
  process.argv[2] === "--repository-setup" &&
  process.argv.length === 5 &&
  process.env["FOOM_SETTINGS_INSTALL"] === "1"
    ? runRepositorySetup(process.argv[3], process.argv[4], process.env)
    : process.argv[2] === "--install-agent"
      ? process.argv.length === 4
        ? installLocalAgent(process.argv[3])
        : Promise.resolve(2)
      : execute(
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
        )
).then((code) => {
  process.exitCode = code;
});
