import { probeCommand } from "../node-common/agent-probe";
import { exchange } from "./client";
import { formatAgentCapabilities } from "../shared/agent-capabilities";
import { handoffCommand } from "./handoff";
import { validateConfig } from "./config";
import { dirname } from "node:path";
import { object, exact, ControlError } from "../node-common/control-validation";
import { command } from "./commands";
import { call, inherited, pair, profilePath, UnknownOutcome } from "./client";
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
      args.some((value) => Buffer.byteLength(value) > 16384) ||
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
    if (words[0] === "config") {
      const path = words[2];
      if (
        words.length !== 3 ||
        words[1] !== "validate" ||
        !path ||
        path.startsWith("-") ||
        path.includes("\0")
      )
        throw new ControlError("invalid_request");
      const result = await validateConfig(path);
      if (json) output({ problems: result.problems, agents: result.agents ?? [] });
      else
        for (const problem of result.problems)
          output(
            `${JSON.stringify(problem.file)}: ${problem.path}: ${problem.severity === "warning" ? "warning: " : ""}${problem.reason}${problem.detail ? `: ${problem.detail}` : ""}`,
          );
      if (!json) for (const agent of result.agents ?? []) output(formatAgentCapabilities(agent));
      return result.code;
    }
    if (words[0] === "agent" && words[1] === "probe") {
      const request = probeCommand(words.slice(2));
      const token = env["FOOM_CONFIG_TOKEN"];
      const url = env["FOOM_CONFIG_URL"];
      if (!token || !/^[a-f0-9]{64}$/u.test(token) || !url) throw new ControlError("unauthorized");
      const target = new URL(url);
      if (
        target.href !== url ||
        target.protocol !== "http:" ||
        target.hostname !== "127.0.0.1" ||
        !target.port ||
        target.pathname !== "/probe/v1" ||
        target.username ||
        target.password ||
        target.search ||
        target.hash
      )
        throw new ControlError("unauthorized");
      const result = await exchange(url, request, token, undefined, 615000);
      const response = object(result);
      exact(response, ["result", "error"]);
      if (typeof response["error"] === "string")
        throw new ControlError(
          response["error"] === "not_found"
            ? "not_found"
            : response["error"] === "unauthorized"
              ? "unauthorized"
              : response["error"] === "conflict"
                ? "conflict"
                : "unavailable",
        );
      output(result);
      return 0;
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
    const request = persistent
      ? undefined
      : words[0] === "handoff"
        ? await handoffCommand(words, io.input)
        : command(words);
    if (connection && (profile || repository || persistent)) throw new ControlError("forbidden");
    if (!connection && !repository) throw new ControlError("unauthorized");
    const authenticated =
      connection ??
      (await pair(profile ?? profilePath(env), repository ?? "", (code) => {
        io.error(`Pairing code: ${code}. Approve read-only access in Foom within 60 seconds.\n`);
      }));
    try {
      if (request) {
        const result = await call(authenticated, request);
        output({ result });
        if (
          request.method === "wait_for" &&
          request.params["untilEvent"] &&
          typeof result === "object" &&
          result !== null &&
          "timedOut" in result &&
          result.timedOut === true
        )
          return 5;
      } else {
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
    if (error instanceof UnknownOutcome) {
      output({ error: "unknown_outcome", idempotencyKey: error.idempotencyKey }, true);
      return 6;
    }
    const code = error instanceof ControlError ? error.code : "unavailable";
    output({ error: code }, true);
    return code === "invalid_request"
      ? 2
      : code === "unauthorized" || code === "forbidden" || code === "no_parent"
        ? 3
        : 4;
  }
}
