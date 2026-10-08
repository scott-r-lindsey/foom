import { request } from "node:http";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { readDiscovery } from "../node-common/private-files";
import { ControlError, exact, identifier, object } from "../node-common/control-validation";
import type { Connection, Command } from "./types";

export function endpoint(value: string): string {
  const url = new URL(value);
  if (
    url.href !== value ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/control/v1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ControlError("invalid_request");
  return value;
}

export function inherited(env: NodeJS.ProcessEnv): Connection | undefined {
  if (
    !["FOOM_CONTROL_URL", "FOOM_CONTROL_TOKEN", "FOOM_CONTROL_INSTANCE", "FOOM_SESSION"].some(
      (name) => env[name] !== undefined,
    )
  )
    return undefined;
  const token = env["FOOM_CONTROL_TOKEN"];
  if (!token || !/^[a-f0-9]{64}$/u.test(token)) throw new ControlError("unauthorized");
  return {
    token,
    endpoint: endpoint(env["FOOM_CONTROL_URL"] ?? ""),
    instanceId: identifier(env["FOOM_CONTROL_INSTANCE"]),
  };
}

export function profilePath(env: NodeJS.ProcessEnv, platform = process.platform): string {
  const home = homedir();
  const root =
    platform === "darwin"
      ? join(home, "Library/Application Support")
      : platform === "win32"
        ? env["APPDATA"]
        : (env["XDG_CONFIG_HOME"] ?? join(home, ".config"));
  if (!root || !isAbsolute(root)) throw new ControlError("unavailable");
  return join(root, "Foom");
}

/** Strict bounded HTTP; credentials are never redirected or included in error text. */
export function exchange(
  url: string,
  body: unknown,
  token?: string,
  onLine?: (value: unknown) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let size = 0;
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          size += Buffer.byteLength(chunk);
          if (size > (onLine ? 4096 : 262144)) {
            reject(new ControlError("unavailable"));
            req.destroy();
            return;
          }
          text += chunk;
          if (onLine) {
            let end = text.indexOf("\n");
            try {
              while (end >= 0) {
                const value: unknown = JSON.parse(text.slice(0, end));
                text = text.slice(end + 1);
                onLine(value);
                end = text.indexOf("\n");
              }
            } catch (error) {
              reject(error instanceof ControlError ? error : new ControlError("invalid_request"));
              req.destroy();
            }
          }
        });
        res.on("error", () => {
          reject(new ControlError("unavailable"));
        });
        res.on("end", () => {
          try {
            if (
              (onLine && (res.statusCode !== 200 || text.length)) ||
              (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400)
            )
              throw new ControlError(
                res.statusCode === 401
                  ? "unauthorized"
                  : res.statusCode === 403
                    ? "forbidden"
                    : res.statusCode === 429
                      ? "capacity"
                      : "unavailable",
              );
            resolve(onLine ? undefined : JSON.parse(text));
          } catch (error) {
            reject(error instanceof ControlError ? error : new ControlError("invalid_request"));
          }
        });
      },
    );
    const timer = setTimeout(
      () => {
        reject(new ControlError("unavailable"));
        req.destroy();
      },
      onLine ? 65000 : 5000,
    );
    req.on("close", () => {
      clearTimeout(timer);
    });
    req.on("error", (error) => {
      reject(error instanceof ControlError ? error : new ControlError("unavailable"));
    });
    req.end(JSON.stringify(body));
  });
}

function serverError(value: unknown): ControlError {
  const codes = [
    "invalid_request",
    "unauthorized",
    "forbidden",
    "not_found",
    "conflict",
    "capacity",
    "unavailable",
  ] as const;
  return new ControlError(codes.find((code) => code === value) ?? "unavailable");
}

export async function call(connection: Connection, command: Command): Promise<unknown> {
  const value = object(
    await exchange(
      connection.endpoint,
      { version: 1, instanceId: connection.instanceId, ...command },
      connection.token,
    ),
  );
  exact(value, ["result", "error"]);
  if (typeof value["error"] === "string") {
    throw serverError(value["error"]);
  }
  if (!("result" in value)) throw new ControlError("invalid_request");
  return value["result"];
}

export async function pair(
  profile: string,
  repository: string,
  announce: (code: string) => void,
): Promise<Connection> {
  if (
    !isAbsolute(profile) ||
    !isAbsolute(repository) ||
    /[\p{Cc}\p{Cf}]/u.test(repository) ||
    repository.length > 4096
  )
    throw new ControlError("invalid_request");
  const discovery = await readDiscovery(join(profile, "control"));
  let token: string | undefined;
  let announced = false;
  await exchange(
    `${discovery.endpoint}/pair`,
    { version: 1, instanceId: discovery.instanceId, repository },
    undefined,
    (line) => {
      const value = object(line);
      exact(value, ["pairing", "grant", "error"]);
      if (value["error"] !== undefined) throw serverError(value["error"]);
      if (value["pairing"] && !announced) {
        const pairing = object(value["pairing"]);
        if (typeof pairing["code"] !== "string" || !/^[A-F0-9]{8}$/u.test(pairing["code"]))
          throw new ControlError("invalid_request");
        announced = true;
        announce(pairing["code"]);
      } else if (announced && value["grant"] && token === undefined) {
        const grant = object(value["grant"]);
        if (
          typeof grant["token"] !== "string" ||
          !/^[a-f0-9]{64}$/u.test(grant["token"]) ||
          typeof grant["expiresAt"] !== "number" ||
          grant["expiresAt"] <= Date.now() ||
          grant["expiresAt"] > Date.now() + 600000
        )
          throw new ControlError("invalid_request");
        token = grant["token"];
      } else throw new ControlError("invalid_request");
    },
  );
  if (!token) throw new ControlError("forbidden");
  return { endpoint: discovery.endpoint, instanceId: discovery.instanceId, token };
}
