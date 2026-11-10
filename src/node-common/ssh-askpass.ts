import { connect, isIP } from "node:net";

function promptTarget(value: string, address = false) {
  const qualified = /^\[([a-zA-Z0-9_.:-]+)\]:([1-9][0-9]{0,4})$/u.exec(value);
  const name = qualified?.[1] ?? value;
  const port = qualified ? Number(qualified[2]) : undefined;
  if (
    (port !== undefined && port > 65535) ||
    (!isIP(name) && (address || !/^[a-zA-Z0-9_.-]+$/u.test(name)))
  )
    return undefined;
  return { port };
}

/** Closed OpenSSH unknown-host question. No prompt text is ever rendered. */
export function hostKeyPrompt(prompt: string, expected?: { host: string; port: number }) {
  if (prompt.length > 4096) return undefined;
  const lines = prompt.split("\n");
  if (lines.length > 13 || lines.some((line) => line.length > 512)) return undefined;
  const match =
    /^The authenticity of host '([a-zA-Z0-9_.:[\]-]+) \(([^\n()]+)\)' can't be established\.\n(ED25519|RSA|ECDSA|DSA|ED25519-SK|ECDSA-SK) key fingerprint is:? (SHA256:[A-Za-z0-9+/]{43})\.?\n(?:This key is not known by any other names\.?\n|This host key is known by the following other names\/addresses:\n(?:    [^\p{Cc}]+:[1-9][0-9]{0,9}: [^\p{Cc}]+\n){1,8}(?:    \([1-9][0-9]{0,9} additional names (?:omitted|ommitted)\)\n)?)?Are you sure you want to continue connecting \(yes\/no\/\[fingerprint\]\)\? $/u.exec(
      prompt,
    );
  if (!match) return undefined;
  const [, host, address, type, fingerprint] = match;
  if (
    !host ||
    !address ||
    !type ||
    !fingerprint ||
    (expected !== undefined && host !== expected.host)
  )
    return undefined;
  const target = promptTarget(host);
  const ip = address === "<no hostip for proxy command>" ? undefined : promptTarget(address, true);
  const port = expected?.port ?? target?.port ?? ip?.port ?? 22;
  if (
    !target ||
    (!ip && address !== "<no hostip for proxy command>") ||
    (target.port !== undefined && target.port !== port) ||
    (ip !== undefined && (ip.port ?? 22) !== port)
  )
    return undefined;
  return { host, type, fingerprint };
}

/** Invoked only by SSH_ASKPASS; never uses discovery, profiles or credentials. */
export async function sshAskpass(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  out: (text: string) => void,
): Promise<number> {
  const prompt = args[0];
  const token = env["FOOM_ASKPASS_TOKEN"];
  const socket = env["FOOM_ASKPASS_SOCKET"];
  if (
    args.length !== 1 ||
    !prompt ||
    !token ||
    !/^[a-f0-9]{64}$/u.test(token) ||
    !socket ||
    !socket.startsWith("/") ||
    socket.length > 100
  )
    return 1;
  const rejected = !hostKeyPrompt(prompt);
  return new Promise((resolve) => {
    const client = connect(socket);
    let response = "";
    const timer = setTimeout(() => client.destroy(), 120000);
    client.on("connect", () =>
      client.write(`${JSON.stringify(rejected ? { token, rejected: true } : { token, prompt })}\n`),
    );
    client.on("data", (data: Buffer) => {
      response += data.toString("utf8");
      if (response.length > 4) client.destroy();
    });
    client.on("error", () => undefined);
    client.on("close", () => {
      clearTimeout(timer);
      if (!rejected && (response === "yes\n" || response === "no\n")) {
        out(response);
        resolve(0);
      } else resolve(1);
    });
  });
}

export function sshFailure(
  stderr: unknown,
): "unreachable" | "host-key-unknown" | "host-key-changed" | "login-rejected" {
  if (typeof stderr !== "string" || Buffer.byteLength(stderr) > 16384) return "unreachable";
  if (/(?:^|\n)@\s+WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\s+@(?:\r?\n|$)/u.test(stderr))
    return "host-key-changed";
  // A generic verification failure is deliberately insufficient to offer trust.
  if (
    /^No (?:ED25519|RSA|ECDSA|DSA|ED25519-SK|ECDSA-SK) host key is known for [a-zA-Z0-9_.:[\]-]+ and you have requested strict checking\.\r?\nHost key verification failed\.\r?\n?$/u.test(
      stderr,
    )
  )
    return "host-key-unknown";
  if (/(?:^|\n)[a-zA-Z0-9_.@-]+: Permission denied \([a-zA-Z0-9, -]+\)\.\r?\n?$/u.test(stderr))
    return "login-rejected";
  return "unreachable";
}
