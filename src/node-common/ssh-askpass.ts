import { connect, isIP } from "node:net";

/** Closed OpenSSH unknown-host question. No prompt text is ever rendered. */
export function hostKeyPrompt(prompt: string, expected?: string) {
  if (prompt.length > 4096) return undefined;
  const match =
    /^The authenticity of host '([a-zA-Z0-9_.:[\]-]+) \(([^\n()]+)\)' can't be established\.\n(ED25519|RSA|ECDSA|DSA|ED25519-SK|ECDSA-SK) key fingerprint is:? (SHA256:[A-Za-z0-9+/]{43})\.?\n(?:This key is not known by any other names\.\n)?Are you sure you want to continue connecting \(yes\/no\/\[fingerprint\]\)\? $/u.exec(
      prompt,
    );
  if (!match) return undefined;
  const [, host, address, type, fingerprint] = match;
  if (
    !host ||
    !address ||
    !type ||
    !fingerprint ||
    (expected !== undefined && host !== expected) ||
    (!isIP(address) && address !== "<no hostip for proxy command>")
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
    !hostKeyPrompt(prompt) ||
    !token ||
    !/^[a-f0-9]{64}$/u.test(token) ||
    !socket ||
    !socket.startsWith("/") ||
    socket.length > 100
  )
    return 1;
  return new Promise((resolve) => {
    const client = connect(socket);
    let response = "";
    const timer = setTimeout(() => client.destroy(), 120000);
    client.on("connect", () => client.write(`${JSON.stringify({ token, prompt })}\n`));
    client.on("data", (data: Buffer) => {
      response += data.toString("utf8");
      if (response.length > 4) client.destroy();
    });
    client.on("error", () => undefined);
    client.on("close", () => {
      clearTimeout(timer);
      if (response === "yes\n" || response === "no\n") {
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
  if (/(?:^|\n)@\s+WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\s+@(?:\n|$)/u.test(stderr))
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
