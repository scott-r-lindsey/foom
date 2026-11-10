import { EventEmitter } from "node:events";
import { connect, createServer } from "node:net";
import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type * as OS from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import { hostKeyPrompt, sshAskpass, sshFailure } from "../../../../src/node-common/ssh-askpass";
const mock = vi.hoisted(() => ({
  temporary: undefined as string | undefined,
  execute:
    vi.fn<
      (
        file: string,
        args: string[],
        options: unknown,
      ) => Promise<{ stdout: string; stderr?: string }>
    >(),
  spawn: vi.fn(),
}));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof OS>();
  return { ...actual, tmpdir: () => mock.temporary ?? actual.tmpdir() };
});
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof ChildProcess>()),
  execFile: Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: (...args: [string, string[], unknown]) =>
      Object.assign(mock.execute(...args), { child: { stdin: { end: vi.fn() }, once: vi.fn() } }),
  }),
  spawn: mock.spawn,
}));
vi.mock("../../../../src/main/login-shell", () => ({ readLoginShell: mock.execute }));
import {
  askpassSupported,
  configuredHost,
  trustHostKey,
} from "../../../../src/main/setup/ssh-host-key";
const fingerprint = `SHA256:${"a".repeat(43)}`;
const question = (host = "box", address = "192.0.2.1") =>
  `The authenticity of host '${host} (${address})' can't be established.\nED25519 key fingerprint is ${fingerprint}.\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? `;
const roots: string[] = [];
beforeEach(() => {
  mock.temporary = undefined;
  mock.execute.mockReset().mockResolvedValue({ stdout: "hostname box\nport 22\n", stderr: "" });
  mock.spawn.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("parses only complete unknown-host questions with a matching target and inert facts", () => {
  expect(hostKeyPrompt(question(), { host: "box", port: 22 })).toEqual({
    host: "box",
    type: "ED25519",
    fingerprint,
  });
  for (const [host, address] of [
    ["[box]:2222", "[192.0.2.1]:2222"],
    ["[box]:2222", "[2001:db8::1]:2222"],
    ["[192.0.2.1]:2222", "[192.0.2.1]:2222"],
    ["[2001:db8::1]:2222", "[2001:db8::1]:2222"],
    ["alias", "[2001:db8::1]:2222"],
  ] as const) {
    expect(hostKeyPrompt(question(host, address), { host, port: 2222 })?.host).toBe(host);
    expect(hostKeyPrompt(question(host, address))?.host).toBe(host);
  }
  expect(hostKeyPrompt(question("box", "2001:db8::1"))?.host).toBe("box");
  expect(hostKeyPrompt(question("box", "<no hostip for proxy command>"))?.host).toBe("box");
  expect(
    hostKeyPrompt(question().replace("is ", "is: ").replace(`${fingerprint}.`, fingerprint))
      ?.fingerprint,
  ).toBe(fingerprint);
  expect(hostKeyPrompt(question(), { host: "imposter", port: 22 })).toBeUndefined();
  expect(
    hostKeyPrompt(question("[box]:2222", "[192.0.2.1]:2222"), { host: "[box]:2222", port: 2223 }),
  ).toBeUndefined();
  expect(
    hostKeyPrompt(question("alias", "[192.0.2.1]:2222"), { host: "alias", port: 22 }),
  ).toBeUndefined();
  expect(hostKeyPrompt(question("[box]:65535", "[192.0.2.1]:65535"))?.host).toBe("[box]:65535");
  expect(hostKeyPrompt(question("[box]:1", "[192.0.2.1]:1"))?.host).toBe("[box]:1");
  for (const text of [
    "Password:",
    "Enter passphrase for key 'key':",
    "Verification code:",
    "Confirm user presence for key ED25519-SK",
    "Host key has changed",
    "x".repeat(4097),
    `prefix${question()}`,
    `${question()}suffix`,
    question("box\u202e"),
    question("box", "evil.test"),
    question("[box]:2222", "192.0.2.1"),
    question("[box]:2222", "[192.0.2.1]:2223"),
    question("[box]:2222", "[2001:db8::1]:2223"),
    question("[box]:0", "[192.0.2.1]:0"),
    question("[box]:65536", "[192.0.2.1]:65536"),
    question("[box]:02222", "[192.0.2.1]:02222"),
    question("[box]:2222", "192.0.2.1:2222"),
    question("[box]:2222", "[192.0.2.999]:2222"),
    question("[box]:2222", "[2001:db8::g]:2222"),
    question("[box]:2222", "[evil.test]:2222"),
    question("[box]:2222", "[192.0.2.1]2222"),
    question("[[box]]:2222", "[192.0.2.1]:2222"),
    question("[bad:host]:2222", "[192.0.2.1]:2222"),
    question().replace(fingerprint, "MD5:aa:bb"),
    question().replace("ED25519", "<script>"),
    question().replace(
      "can't be established.",
      "can't be established\nbut keys of different type are already known for this host.",
    ),
  ])
    expect(hostKeyPrompt(text)).toBeUndefined();
});

test("classifies bounded OpenSSH stderr without trusting generic verification errors", () => {
  expect(
    sshFailure(
      "No ED25519 host key is known for box and you have requested strict checking.\nHost key verification failed.\n",
    ),
  ).toBe("host-key-unknown");
  expect(sshFailure("@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\n")).toBe(
    "host-key-changed",
  );
  expect(sshFailure("me@box: Permission denied (publickey,password).\n")).toBe("login-rejected");
  expect(sshFailure("@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\r\n")).toBe(
    "host-key-changed",
  );
  for (const value of [
    undefined,
    {},
    "Host key verification failed.\n",
    "Permission denied",
    "x".repeat(16385),
    "banner\nNo RSA host key is known for box and you have requested strict checking.\nHost key verification failed.\n",
  ])
    expect(sshFailure(value)).toBe("unreachable");
});

test("resolves aliases and ports only from a bounded single ssh configuration", () => {
  expect(configuredHost("hostname box\nport 22\n")).toEqual({ host: "box", port: 22 });
  expect(configuredHost("hostname 2001:db8::1\nport 2222\n")).toEqual({
    host: "[2001:db8::1]:2222",
    port: 2222,
  });
  expect(configuredHost("hostname box\nport 2222\nhostkeyalias alias\n")).toEqual({
    host: "alias",
    port: 2222,
  });
  for (const value of [
    "",
    "hostname box\n",
    "hostname box\nport 0",
    "hostname box\nport 65536",
    "hostname box\nport a",
    "hostname box\nport 22\nport 23",
    "hostname box\nhostname evil\nport 22",
    "hostname b ox\nport 22",
    "hostname box\nport 22\nhostkeyalias bad'",
    `hostname ${"a".repeat(201)}\nport 22`,
    "hostname box\nport 22\nhostkeyalias a\nhostkeyalias b",
  ])
    expect(configuredHost(value)).toBeUndefined();
});

test("offers the bundled helper only with a supported OpenSSH and executable helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "ask-support-"));
  roots.push(root);
  const executable = join(root, "foom");
  await writeFile(executable, "fixture", { mode: 0o700 });
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  for (const version of [
    "OpenSSH_8.4p1, fixture",
    "OpenSSH_9.9p1, fixture",
    "OpenSSH_10.0 fixture",
  ]) {
    mock.execute
      .mockResolvedValueOnce({ stdout: "", stderr: version })
      .mockResolvedValueOnce({ stdout: "" });
    expect(await askpassSupported(executable)).toBe(true);
  }
  for (const version of ["OpenSSH_8.3", "OpenSSH_7.9", "PuTTY", ""]) {
    mock.execute.mockResolvedValueOnce({ stderr: version, stdout: "" });
    expect(await askpassSupported(executable)).toBe(false);
  }
  mock.execute.mockRejectedValueOnce(new Error("fixture failed"));
  expect(await askpassSupported(executable)).toBe(false);
  mock.execute
    .mockResolvedValueOnce({ stdout: "OpenSSH_9.9 fixture" })
    .mockRejectedValueOnce(new Error("helper failed"));
  expect(await askpassSupported(executable)).toBe(false);
  expect(await askpassSupported(join(root, "missing"))).toBe(false);
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  expect(await askpassSupported(executable)).toBe(false);
});

test("askpass refuses secret prompts and missing/invalid run credentials before connecting", async () => {
  const out = vi.fn();
  expect(await sshAskpass(["--probe"], {}, out)).toBe(1);
  const valid = {
    FOOM_ASKPASS_TOKEN: "a".repeat(64),
    FOOM_ASKPASS_SOCKET: "/tmp/nonexistent-askpass-test",
  };
  for (const [args, env] of [
    [[], valid],
    [["Password:"], valid],
    [[question(), "extra"], valid],
    [[question()], {}],
    [[question()], { ...valid, FOOM_ASKPASS_TOKEN: "bad" }],
    [[question()], { ...valid, FOOM_ASKPASS_SOCKET: "relative" }],
    [[question()], { ...valid, FOOM_ASKPASS_SOCKET: `/${"x".repeat(101)}` }],
  ] satisfies [string[], NodeJS.ProcessEnv][])
    expect(await sshAskpass(args, env, out)).toBe(1);
  expect(await sshAskpass([question()], valid, out)).toBe(1);
  expect(out).not.toHaveBeenCalled();
});

const unixTest = test.skipIf(process.platform === "win32");
unixTest(
  "a detached SSH run authenticates one question, relays only a click, then removes all private files",
  async () => {
    for (const [host, address, config] of [
      ["box", "192.0.2.1", "hostname box\nport 22\n"],
      ["[box]:2222", "[192.0.2.1]:2222", "hostname box\nport 2222\n"],
      ["[2001:db8::1]:2222", "[2001:db8::1]:2222", "hostname 2001:db8::1\nport 2222\n"],
      ["alias", "[2001:db8::1]:2222", "hostname box\nport 2222\nhostkeyalias alias\n"],
    ] as const) {
      for (const answer of [true, false]) {
        mock.execute.mockResolvedValueOnce({ stdout: config });
        const out = vi.fn();
        const confirm = vi.fn(() => Promise.resolve(answer));
        let directory = "";
        mock.spawn.mockImplementation(
          (
            _file: string,
            args: string[],
            options: { env: NodeJS.ProcessEnv; detached: boolean; stdio: string },
          ) => {
            expect(args).toContain("BatchMode=no");
            expect(args).toContain("StrictHostKeyChecking=ask");
            for (const setting of [
              "PasswordAuthentication=no",
              "KbdInteractiveAuthentication=no",
              "ForwardAgent=no",
              "ForwardX11=no",
              "ClearAllForwardings=yes",
              "ControlPath=none",
            ])
              expect(args).toContain(setting);
            expect(args).toContain("-n");
            expect(args).not.toContain("StdinNull=yes");
            expect(args.at(-1)).toBe("true");
            expect(options.detached).toBe(true);
            expect(options.stdio).toBe("ignore");
            expect(options.env["DISPLAY"]).toBeUndefined();
            expect(options.env["SSH_ASKPASS_REQUIRE"]).toBe("force");
            directory = dirname(options.env["FOOM_ASKPASS_SOCKET"] ?? "");
            const child = new EventEmitter();
            void (async () => {
              expect((await stat(directory)).mode & 0o777).toBe(0o700);
              await sshAskpass([question(host, address)], options.env, out);
              child.emit("exit", 0);
              child.emit("close", 0);
            })();
            return child;
          },
        );
        expect(
          await trustHostKey(
            "user@alias",
            confirm,
            new AbortController().signal,
            "/fixture console/foom",
          ),
        ).toBe(answer);
        expect(confirm).toHaveBeenCalledOnce();
        if (answer) expect(out).toHaveBeenCalledWith("yes\n");
        await expect(access(directory)).rejects.toThrow();
      }
    }
  },
);

unixTest(
  "unrecognized, unauthenticated and replayed helper messages cannot approve trust",
  async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    mock.spawn.mockImplementation(
      (_file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = new EventEmitter();
        void (async () => {
          for (const payload of [
            "{\n",
            "null\n",
            "1\n",
            "[]\n",
            "{}\n",
            `${JSON.stringify({ token: options.env["FOOM_ASKPASS_TOKEN"], extra: "bad" })}\n`,
            `${JSON.stringify({ token: options.env["FOOM_ASKPASS_TOKEN"], prompt: 1 })}\n`,
            "x".repeat(8193),
            `${JSON.stringify({ token: "wrong", prompt: question() })}\n`,
            `${JSON.stringify({ token: options.env["FOOM_ASKPASS_TOKEN"], prompt: question("evil") })}\n`,
            `${JSON.stringify({ token: options.env["FOOM_ASKPASS_TOKEN"], prompt: "Password:" })}\n`,
          ]) {
            await new Promise<void>((resolve) => {
              const socket = connect(options.env["FOOM_ASKPASS_SOCKET"] ?? "");
              socket.on("connect", () => socket.write(payload));
              socket.on("error", () => undefined);
              socket.on("close", () => {
                resolve();
              });
            });
          }
          expect(await sshAskpass([question()], options.env, vi.fn())).toBe(0);
          expect(await sshAskpass([question()], options.env, vi.fn())).toBe(1);
          child.emit("close", 0);
        })();
        return child;
      },
    );
    expect(await trustHostKey("alias", confirm, new AbortController().signal)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  },
);

unixTest(
  "cancel and quit abort the dialog, kill the process group and revoke the socket",
  async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    for (const reason of ["cancel", "quit"]) {
      const abort = new AbortController();
      const ready = Promise.withResolvers<undefined>();
      let directory = "";
      let child: EventEmitter | undefined;
      mock.spawn.mockImplementation(
        (_file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
          child = Object.assign(new EventEmitter(), { pid: 12345 });
          directory = dirname(options.env["FOOM_ASKPASS_SOCKET"] ?? "");
          void sshAskpass([question()], options.env, vi.fn());
          return child;
        },
      );
      const work = trustHostKey(
        "alias",
        async (_content, signal) => {
          ready.resolve(undefined);
          return new Promise<boolean>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                resolve(false);
              },
              { once: true },
            );
          });
        },
        abort.signal,
      );
      await ready.promise;
      abort.abort(reason);
      expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
      child?.emit("close", null);
      expect(await work).toBe(false);
      await expect(access(directory)).rejects.toThrow();
    }
  },
);

unixTest(
  "refuses invalid hosts, cancelled runs and failed SSH configuration before spawning",
  async () => {
    const abort = new AbortController();
    abort.abort();
    expect(await trustHostKey("alias", vi.fn(), abort.signal)).toBe(false);
    expect(await trustHostKey("-bad", vi.fn(), new AbortController().signal)).toBe(false);
    mock.execute.mockRejectedValueOnce(new Error("failed"));
    expect(await trustHostKey("alias", vi.fn(), new AbortController().signal)).toBe(false);
    mock.execute.mockResolvedValueOnce({ stdout: "hostname bad\n" });
    expect(await trustHostKey("alias", vi.fn(), new AbortController().signal)).toBe(false);
    expect(mock.spawn).not.toHaveBeenCalled();
  },
);

unixTest("askpass accepts only a complete yes/no reply and expires a silent peer", async () => {
  const root = await mkdtemp(join(tmpdir(), "ask-reply-"));
  roots.push(root);
  const socketPath = join(root, "s");
  let reply = "no\n";
  const ready = Promise.withResolvers<undefined>();
  const server = createServer((socket) => {
    socket.on("data", () => {
      if (reply) socket.end(reply);
      else ready.resolve(undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const env = { FOOM_ASKPASS_TOKEN: "a".repeat(64), FOOM_ASKPASS_SOCKET: socketPath };
  const out = vi.fn();
  try {
    expect(await sshAskpass([question()], env, out)).toBe(0);
    expect(out).toHaveBeenCalledWith("no\n");
    for (reply of ["bad\n", "yes\nextra"]) expect(await sshAskpass([question()], env, out)).toBe(1);
    reply = "";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const work = sshAskpass([question()], env, out);
    await ready.promise;
    await vi.advanceTimersByTimeAsync(120000);
    expect(await work).toBe(1);
  } finally {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});

unixTest("SSH lifetime expiry and spawn failures revoke the run without approval", async () => {
  for (const mode of ["timeout", "spawn-error"] as const) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ready = Promise.withResolvers<undefined>();
    const child = Object.assign(new EventEmitter(), { pid: 12345 });
    vi.spyOn(process, "kill").mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("close", null);
      });
      throw new Error("already gone");
    });
    mock.spawn.mockImplementation(() => {
      ready.resolve(undefined);
      if (mode === "spawn-error")
        queueMicrotask(() => {
          child.emit("error", new Error("fixture"));
          child.emit("close", null);
        });
      return child;
    });
    const report = vi.fn();
    const work = trustHostKey(
      "alias",
      () => Promise.resolve(false),
      new AbortController().signal,
      undefined,
      report,
    );
    await ready.promise;
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(120000);
    expect(await work).toBe(false);
    expect(report).toHaveBeenCalledWith(mode === "timeout" ? "trust-timeout" : "ssh-start-failed");
    vi.useRealTimers();
  }
});

unixTest("a failed trusted dialog revokes a waiting helper and never answers yes", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 12345 });
  const out = vi.fn();
  vi.spyOn(process, "kill").mockImplementation(() => {
    queueMicrotask(() => {
      child.emit("close", null);
    });
    return true;
  });
  mock.spawn.mockImplementation(
    (_file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      void sshAskpass([question()], options.env, out);
      return child;
    },
  );
  expect(
    await trustHostKey(
      "alias",
      () => Promise.reject(new Error("dialog failed")),
      new AbortController().signal,
    ),
  ).toBe(false);
  expect(out).not.toHaveBeenCalledWith("yes\n");
});

test("cancelling capability detection cancels its detached version/helper read", async () => {
  const root = await mkdtemp(join(tmpdir(), "ask-support-cancel-"));
  roots.push(root);
  const executable = join(root, "foom");
  await writeFile(executable, "fixture", { mode: 0o700 });
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const abort = new AbortController();
  const ready = Promise.withResolvers<undefined>();
  mock.execute.mockImplementationOnce((_file, _args, options) => {
    if (
      !options ||
      typeof options !== "object" ||
      !("signal" in options) ||
      !(options.signal instanceof AbortSignal)
    )
      throw new Error("Missing cancellation");
    const signal = options.signal;
    ready.resolve(undefined);
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          reject(new Error("cancelled"));
        },
        { once: true },
      );
    });
  });
  const work = askpassSupported(executable, abort.signal);
  await ready.promise;
  abort.abort();
  expect(await work).toBe(false);
});

test("accepts bounded OpenSSH 8.4, 8.5 and current other-name message formats without projecting their text", () => {
  const base = question().replace("This key is not known by any other names.\n", "");
  expect(hostKeyPrompt(base)?.host).toBe("box");
  expect(hostKeyPrompt(question().replace("names.", "names"))?.host).toBe("box");
  const block = (lines: string) =>
    base.replace(
      "Are you sure",
      `This host key is known by the following other names/addresses:\n${lines}Are you sure`,
    );
  for (const lines of [
    "    ~/.ssh/known_hosts:12: 192.0.2.1\n",
    "    /fixture/known hosts:42: box,192.0.2.1\n    ~/.ssh/known_hosts:15: [hashed name]\n",
    ...["omitted", "ommitted"].map(
      (word) =>
        `${Array.from({ length: 8 }, (_, index) => `    /fixture/known_hosts:${String(index + 1)}: host-${String(index)}\n`).join("")}    (3 additional names ${word})\n`,
    ),
  ]) {
    expect(hostKeyPrompt(block(lines), { host: "box", port: 22 })).toEqual({
      host: "box",
      type: "ED25519",
      fingerprint,
    });
    expect(hostKeyPrompt(block(lines), { host: "evil", port: 22 })).toBeUndefined();
  }
  for (const lines of [
    "",
    "    Password:\n",
    "    /fixture/known_hosts:0: box\n",
    "    /fixture/known_hosts:1: box\nInjected question\n",
    `    /fixture/${"x".repeat(513)}:1: box\n`,
    "    /fixture/known_hosts:1: box\u001b[0m\n",
    Array.from({ length: 9 }, () => "    /fixture/known_hosts:1: box\n").join(""),
    "    /fixture/known_hosts:1: box\n    (0 additional names omitted)\n",
  ])
    expect(hostKeyPrompt(block(lines))).toBeUndefined();
  expect(configuredHost("hostname MiXeD.example\nport 22\n")).toEqual({
    host: "mixed.example",
    port: 22,
  });
  expect(configuredHost("hostname box\nport 22\nhostkeyalias MiXeD\n")).toEqual({
    host: "MiXeD",
    port: 22,
  });
});

unixTest("reports distinct fixed reasons for alias and SSH configuration failures", async () => {
  const report = vi.fn();
  expect(await trustHostKey("-bad", vi.fn(), new AbortController().signal, undefined, report)).toBe(
    false,
  );
  expect(report).toHaveBeenLastCalledWith("invalid-alias");
  mock.execute.mockRejectedValueOnce(new Error("private config text"));
  expect(
    await trustHostKey("alias", vi.fn(), new AbortController().signal, undefined, report),
  ).toBe(false);
  expect(report).toHaveBeenLastCalledWith("ssh-config-failed");
  mock.execute.mockResolvedValueOnce({ stdout: "hostname bad\n" });
  expect(
    await trustHostKey("alias", vi.fn(), new AbortController().signal, undefined, report),
  ).toBe(false);
  expect(report).toHaveBeenLastCalledWith("ssh-config-invalid");
});

unixTest.each([
  { prompt: "Password:", reason: "askpass-prompt-rejected" },
  { prompt: question("evil"), reason: "prompt-host-mismatch" },
  { prompt: undefined, reason: "ssh-exited-without-prompt" },
])("reports $reason without a dialog or raw prompt", async ({ prompt, reason }) => {
  const report = vi.fn();
  const confirm = vi.fn();
  mock.spawn.mockImplementation(
    (_file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      const child = new EventEmitter();
      void (async () => {
        await Promise.resolve();
        if (prompt) expect(await sshAskpass([prompt], options.env, vi.fn())).toBe(1);
        child.emit("close", 255);
      })();
      return child;
    },
  );
  expect(
    await trustHostKey("alias", confirm, new AbortController().signal, undefined, report),
  ).toBe(false);
  expect(confirm).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledExactlyOnceWith(reason);
});

unixTest(
  "socket path overflow is a fixed visible failure and removes the private directory",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "long-askpass-"));
    roots.push(root);
    const long = join(root, "x".repeat(100));
    await import("node:fs/promises").then(({ mkdir }) => mkdir(long));
    mock.temporary = long;
    const report = vi.fn();
    expect(
      await trustHostKey("alias", vi.fn(), new AbortController().signal, undefined, report),
    ).toBe(false);
    expect(report).toHaveBeenCalledExactlyOnceWith("socket-path-too-long");
    expect(await import("node:fs/promises").then(({ readdir }) => readdir(long))).toEqual([]);
  },
);
