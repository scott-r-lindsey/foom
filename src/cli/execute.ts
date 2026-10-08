import { dirname } from "node:path";
import { ControlError } from "../node-common/control-validation";
import { command } from "./commands";
import { call, inherited, pair, profilePath } from "./client";
import { installCli } from "./install";
import { run } from "./cli";
import type { ConsoleIo } from "./types";

export async function execute(
  args: readonly string[],
  version: string,
  io: ConsoleIo,
  env: NodeJS.ProcessEnv,
  executable: string,
): Promise<number> {
  const json = args.includes("--json");
  const output = (value: unknown, error = false) => {
    const text = json || typeof value !== "string" ? JSON.stringify(value) : value;
    if (error) io.error(`${text}\n`);
    else io.out(`${text}\n`);
  };
  try {
    if (
      args.length > 32 ||
      args.some((value) => value.length > 4096) ||
      args.filter((value) => value === "--json").length > 1
    )
      throw new ControlError("invalid_request");
    const words = args.filter((arg) => arg !== "--json");
    if (
      words.length === 0 ||
      ["--version", "--help", "--validate-config"].includes(words[0] ?? "")
    ) {
      const result = run(args, version);
      output(result.output, result.error);
      return result.code;
    }
    const connection = inherited(env);
    if (words[0] === "--install-cli" || words[0] === "--uninstall-cli") {
      if (connection) throw new ControlError("forbidden");
      if (words.length !== 2 && !(process.platform === "win32" && words.length === 1))
        throw new ControlError("invalid_request");
      output(
        await installCli(
          executable,
          words[1] ?? dirname(executable),
          words[0] === "--uninstall-cli",
          env,
        ),
      );
      return 0;
    }
    let profile: string | undefined;
    let repository: string | undefined;
    for (let i = 0; i < words.length; ) {
      const flag = words[i];
      if (flag !== "--profile" && flag !== "--repository") {
        i++;
        continue;
      }
      const value = words[i + 1];
      if (
        !value ||
        value.startsWith("--") ||
        (flag === "--profile" ? profile : repository) !== undefined
      )
        throw new ControlError("invalid_request");
      if (flag === "--profile") profile = value;
      else repository = value;
      words.splice(i, 2);
    }
    const persistent = words.length === 1 && words[0] === "pair";
    const request = persistent ? undefined : command(words);
    if (connection && (profile || repository || persistent)) throw new ControlError("forbidden");
    if (!connection && !repository) throw new ControlError("unauthorized");
    const authenticated =
      connection ??
      (await pair(profile ?? profilePath(env), repository ?? "", (code) => {
        io.error(`Pairing code: ${code}. Approve read-only access in Foom within 60 seconds.\n`);
      }));
    try {
      if (request) output({ result: await call(authenticated, request) });
      else {
        output({ ready: true, protocol: 1 });
        let buffer = "";
        for await (const chunk of io.input) {
          buffer += chunk.toString();
          if (Buffer.byteLength(buffer) > 65536) throw new ControlError("invalid_request");
          let index = buffer.indexOf("\n");
          while (index >= 0) {
            let value: unknown;
            try {
              value = JSON.parse(buffer.slice(0, index));
            } catch {
              throw new ControlError("invalid_request");
            }
            buffer = buffer.slice(index + 1);
            if (
              !Array.isArray(value) ||
              !value.every((arg): arg is string => typeof arg === "string")
            )
              throw new ControlError("invalid_request");
            output({ result: await call(authenticated, command(value)) });
            index = buffer.indexOf("\n");
          }
        }
        if (buffer.trim()) throw new ControlError("invalid_request");
      }
    } finally {
      if (!connection)
        await call(authenticated, { method: "release_cli", params: {} }).catch(() => undefined);
    }
    return 0;
  } catch (error) {
    const code = error instanceof ControlError ? error.code : "unavailable";
    output({ error: code }, true);
    return code === "invalid_request" ? 2 : code === "unauthorized" || code === "forbidden" ? 3 : 4;
  }
}
