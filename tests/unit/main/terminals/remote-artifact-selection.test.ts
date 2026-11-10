import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({
  output: "Linux\nx86_64\n",
  failure: false,
  spawn: vi.fn(),
  execFile:
    vi.fn<
      (
        file: string,
        args: string[],
        options: unknown,
        callback: (error: Error | null, result: { stdout: string }) => void,
      ) => void
    >(),
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, fstatSync: vi.fn(actual.fstatSync) };
});
vi.mock("node:child_process", () => ({ execFile: mock.execFile, spawn: mock.spawn }));
import {
  selectHostArtifact,
  remoteHostsAvailable,
  sshEnvironment,
} from "../../../../src/main/terminals/remote-bootstrap";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(mock.execFile, Symbol.for("nodejs.util.promisify.custom"));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function probeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "host-selection-"));
  roots.push(root);
  mock.output = "Linux\nx86_64\n";
  mock.failure = false;
  mock.spawn.mockReset().mockImplementation((file: string, args: string[], options: unknown) => {
    const child = probeChild();
    queueMicrotask(() => {
      mock.execFile(file, args, options, (error, result) => {
        if (result.stdout) child.stdout.write(result.stdout);
        child.emit("exit", error ? 1 : 0);
        child.emit("close", error ? 1 : 0);
      });
    });
    return child;
  });
  mock.execFile.mockImplementation((_file, _args, _options, callback) => {
    callback(mock.failure ? new Error("probe failed") : null, { stdout: mock.output });
  });
  const directory = join(root, "linux-x64");
  await mkdir(directory);
  const bytes = Buffer.from("fixture host");
  const compressed = gzipSync(bytes);
  const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  const manifest = {
    version: "0.1.0",
    source: "a".repeat(40),
    protocol: 3,
    platform: "linux",
    arch: "x64",
    size: bytes.length,
    sha256: hash(bytes),
    gzipSize: compressed.length,
    gzipSha256: hash(compressed),
  };
  const path = join(directory, "foom-host.gz");
  await writeFile(path, compressed);
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  const metadata = join(root, "build-metadata.json");
  await writeFile(
    metadata,
    JSON.stringify({ source: manifest.source, remoteHostsAvailable: true }),
  );
  return { root, path, metadata, manifest, directory };
}

test("uses bounded SSH discovery and a fixed catalog path, validates version and override platform", async () => {
  const f = await fixture();
  vi.stubEnv("FOOM_CONTROL_TOKEN", "never send");
  vi.stubEnv("SSH_AUTH_SOCK", "/fixture/agent");
  const target = { host: "fixture" };
  expect((await selectHostArtifact(target, "0.1.0", f.root, f.metadata)).platform).toBe("linux");
  expect(mock.spawn).toHaveBeenLastCalledWith(
    "ssh",
    expect.arrayContaining(["--", "fixture", "uname -s; uname -m"]),
    expect.objectContaining({
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    }),
  );
  expect(sshEnvironment()).not.toHaveProperty("FOOM_CONTROL_TOKEN");
  expect(sshEnvironment()).toHaveProperty("SSH_AUTH_SOCK", "/fixture/agent");
  await expect(selectHostArtifact(target, "0.2.0", f.root, f.metadata)).rejects.toThrow();
  mock.output = "Darwin\narm64\n";
  await expect(
    selectHostArtifact({ ...target, artifact: f.path }, "0.1.0", f.root, f.metadata),
  ).rejects.toThrow();
  await expect(selectHostArtifact(target, "0.1.0", f.root, f.metadata)).rejects.toThrow();
  mock.output = "Linux\nx86_64\nextra";
  await expect(selectHostArtifact(target, "0.1.0", f.root, f.metadata)).rejects.toThrow(
    "Unsupported",
  );
  mock.failure = true;
  await expect(selectHostArtifact(target, "0.1.0", f.root, f.metadata)).rejects.toThrow(
    "unreachable",
  );
  await expect(
    selectHostArtifact({ host: "-oProxyCommand=id" }, "0.1.0", f.root, f.metadata),
  ).rejects.toThrow("host");
});

test("defaults to the bundled catalog and fails closed when it is absent", async () => {
  await fixture();
  await expect(selectHostArtifact({ host: "fixture" }, "missing-version")).rejects.toThrow();
});

test("catalog selection pins same-version hosts to trusted app metadata", async () => {
  const f = await fixture();
  for (const source of [undefined, null, 1, "development", "bad", "b".repeat(40)]) {
    await writeFile(join(f.directory, "manifest.json"), JSON.stringify({ ...f.manifest, source }));
    await expect(
      selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata),
    ).rejects.toThrow();
  }
  // Explicit developer override allows another valid commit, preserving byte/platform checks.
  await expect(
    selectHostArtifact({ host: "fixture", artifact: f.path }, "0.1.0", f.root, f.metadata),
  ).resolves.toHaveProperty("version", "0.1.0");
  await writeFile(join(f.directory, "manifest.json"), JSON.stringify(f.manifest));
  for (const value of [null, {}, { source: 1 }, { source: "development" }]) {
    await writeFile(f.metadata, JSON.stringify(value));
    await expect(
      selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata),
    ).rejects.toMatchObject({ code: "remote-host-unavailable" });
  }
  await rm(f.metadata);
  await expect(
    selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata),
  ).rejects.toThrow();
});

test("local packages without a catalog refuse remote shells and allow a verified override", async () => {
  const f = await fixture();
  await writeFile(
    f.metadata,
    JSON.stringify({ source: f.manifest.source, remoteHostsAvailable: false }),
  );
  mock.execFile.mockClear();
  await expect(
    selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata),
  ).rejects.toThrow("foom-error:remote-host-unavailable");
  expect(mock.execFile).not.toHaveBeenCalled();
  await expect(
    selectHostArtifact({ host: "fixture", artifact: f.path }, "0.1.0", f.root, f.metadata),
  ).resolves.toHaveProperty("version", "0.1.0");
});

test("missing availability metadata and damaged runtime catalog files are artifact unavailable", async () => {
  const f = await fixture();
  for (const value of [
    "{",
    JSON.stringify({ source: f.manifest.source }),
    JSON.stringify({ source: f.manifest.source, remoteHostsAvailable: false }),
  ]) {
    await writeFile(f.metadata, value);
    mock.execFile.mockClear();
    await expect(
      selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata),
    ).rejects.toMatchObject({ code: "remote-host-unavailable" });
    expect(mock.execFile).not.toHaveBeenCalled();
  }
  await writeFile(
    f.metadata,
    JSON.stringify({ source: f.manifest.source, remoteHostsAvailable: true }),
  );
  await rm(f.path);
  await expect(
    selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata),
  ).rejects.toMatchObject({ code: "remote-host-unavailable" });
  await writeFile(f.path, "bad gzip");
  await expect(
    selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata),
  ).rejects.toMatchObject({ code: "remote-host-unavailable" });
});

test("preflight observes SSH and platform even when the build omits remote artifacts", async () => {
  const f = await fixture();
  await writeFile(
    f.metadata,
    JSON.stringify({ source: f.manifest.source, remoteHostsAvailable: false }),
  );
  const observe = vi.fn();
  await expect(
    selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata, undefined, observe),
  ).rejects.toMatchObject({ code: "remote-host-unavailable" });
  expect(observe.mock.calls).toEqual([
    ["ssh", { state: "pass" }],
    ["platform", { state: "pass" }],
    ["artifact", { state: "fail", reason: "artifact-unavailable" }],
  ]);
  mock.failure = true;
  observe.mockClear();
  await expect(
    selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata, undefined, observe),
  ).rejects.toThrow("unreachable");
  expect(observe.mock.calls).toEqual([["ssh", { state: "fail", reason: "unreachable" }]]);
});

test.each(["unsupported", "libc-too-old", "libc-unsupported", "pass"])(
  "preflight platform and artifact observations: %s",
  async (state) => {
    const f = await fixture();
    const observe = vi.fn();
    if (state === "unsupported") mock.output = "Unsupported\nx86_64\n";
    if (state.startsWith("libc"))
      mock.execFile.mockImplementation((_file, args, _options, callback) => {
        callback(
          args.includes("-c")
            ? Object.assign(new Error("raw"), {
                stdout: state === "libc-too-old" ? "FOOM-LIBC-TOO-OLD" : "FOOM-LIBC-UNSUPPORTED",
              })
            : null,
          { stdout: mock.output },
        );
      });
    const result = selectHostArtifact(
      { host: "fixture" },
      "0.1.0",
      f.root,
      f.metadata,
      undefined,
      observe,
    );
    if (state === "pass") {
      await expect(result).resolves.toHaveProperty("platform", "linux");
      expect(observe).toHaveBeenLastCalledWith("artifact", { state: "pass" });
    } else {
      await expect(result).rejects.toThrow("Unsupported");
      expect(observe).toHaveBeenLastCalledWith("platform", { state: "fail", reason: state });
    }
  },
);

test("a disconnected libc probe does not invent an unsupported platform; mismatched artifacts remain explicit", async () => {
  const f = await fixture();
  const observe = vi.fn();
  mock.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
    callback(null, { stdout: mock.output });
  });
  mock.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
    callback(new Error("raw network failure"), { stdout: "" });
  });
  await expect(
    selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata, undefined, observe),
  ).rejects.toThrow("unreachable");
  expect(observe.mock.calls.slice(-2)).toEqual([
    ["ssh", { state: "fail", reason: "unreachable" }],
    ["platform", { state: "not-checked" }],
  ]);
  observe.mockClear();
  await expect(
    selectHostArtifact({ host: "fixture" }, "0.2.0", f.root, f.metadata, undefined, observe),
  ).rejects.toThrow();
  expect(observe).toHaveBeenLastCalledWith("artifact", {
    state: "fail",
    reason: "version-mismatch",
  });
});

test("explicit setup output streams SSH stdout and stderr as inert display text", async () => {
  const f = await fixture();
  mock.spawn.mockImplementation(() => {
    const child = probeChild();
    queueMicrotask(() => {
      child.stdout.write(mock.output);
      child.stderr.write("SSH diagnostic\n");
      child.emit("exit", 0);
      child.emit("close", 0);
    });
    return child;
  });
  const output = vi.fn();
  await selectHostArtifact(
    { host: "fixture" },
    "0.1.0",
    f.root,
    f.metadata,
    undefined,
    undefined,
    output,
  );
  expect(output.mock.calls).toEqual([
    ["Connecting…\nPlatform\n", true],
    ["Linux\nx86_64\n"],
    ["SSH diagnostic\n"],
    ["Verifying daemon artifact…\n", true],
  ]);
});

test.each([
  { source: "remote", code: 1, expected: "unreachable" },
  { source: "remote", code: 255, expected: "unreachable" },
  { source: "client", code: 1, expected: "unreachable" },
  { source: "client", code: 255, expected: "host-key-unknown" },
  { source: "oversized-client", code: 255, expected: "unreachable" },
])(
  "only a local SSH exit 255 diagnostic enables trust: $source/$code",
  async ({ source, code, expected }) => {
    const f = await fixture();
    await writeFile(
      f.metadata,
      JSON.stringify({ source: f.manifest.source, remoteHostsAvailable: false }),
    );
    const observe = vi.fn();
    const output = vi.fn();
    const text =
      "No ED25519 host key is known for box and you have requested strict checking.\nHost key verification failed.\n";
    let diagnostic = "";
    mock.spawn.mockImplementation((_file: string, args: string[]) => {
      expect(args).toContain("LogLevel=ERROR");
      expect(args).toContain("StrictHostKeyChecking=yes");
      diagnostic = args[args.indexOf("-E") + 1] ?? "";
      const child = probeChild();
      void (async () => {
        if (process.platform !== "win32") expect((await stat(diagnostic)).mode & 0o777).toBe(0o600);
        if (source !== "remote")
          await writeFile(diagnostic, source === "client" ? text : "x".repeat(16385));
        else child.stderr.write(text);
        child.emit("exit", code);
        child.emit("close", code);
      })();
      return child;
    });
    await expect(
      selectHostArtifact(
        { host: "fixture" },
        "0.1.0",
        f.root,
        f.metadata,
        undefined,
        observe,
        output,
      ),
    ).rejects.toMatchObject({ failure: expected });
    expect(observe.mock.calls).toEqual([["ssh", { state: "fail", reason: expected }]]);
    if (source === "client") expect(output).toHaveBeenCalledWith(text);
    await expect(access(diagnostic)).rejects.toThrow();
  },
);

test("a live diagnostic overflow kills the owned SSH group and cannot become trust eligible", async () => {
  const f = await fixture();
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  const ready = Promise.withResolvers<undefined>();
  const child = Object.assign(probeChild(), { pid: 12345 });
  let diagnostic = "";
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    // Even a smaller, syntactically valid diagnostic after overflow cannot
    // undo the failed-probe latch.
    fs.writeFileSync(
      diagnostic,
      "No ED25519 host key is known for box and you have requested strict checking.\nHost key verification failed.\n",
    );
    queueMicrotask(() => {
      child.emit("exit", 255);
      child.emit("close", 255);
    });
    return true;
  });
  mock.spawn.mockImplementation((_file: string, args: string[], options: { detached: boolean }) => {
    expect(options.detached).toBe(true);
    diagnostic = args[args.indexOf("-E") + 1] ?? "";
    void writeFile(diagnostic, Buffer.alloc(16385)).then(() => {
      ready.resolve(undefined);
    });
    return child;
  });
  const work = expect(
    selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata),
  ).rejects.toMatchObject({ failure: "unreachable" });
  await ready.promise;
  expect(kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10);
  await work;
  expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
  await expect(access(diagnostic)).rejects.toThrow();
  expect(vi.getTimerCount()).toBe(0);
});

test("a successful probe that overflows before the first monitor tick still fails closed", async () => {
  const f = await fixture();
  let diagnostic = "";
  mock.spawn.mockImplementation((_file: string, args: string[]) => {
    const child = probeChild();
    diagnostic = args[args.indexOf("-E") + 1] ?? "";
    void writeFile(diagnostic, Buffer.alloc(16385)).then(() => {
      child.stdout.write("Linux\nx86_64\n");
      child.emit("exit", 0);
      child.emit("close", 0);
    });
    return child;
  });
  await expect(
    selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata),
  ).rejects.toMatchObject({ failure: "unreachable" });
  await expect(access(diagnostic)).rejects.toThrow();
});

test.each(["stdout", "stderr", "abort", "timeout", "spawn", "stat"])(
  "bounded SSH probe stops and cleans up on %s",
  async (mode) => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const ready = Promise.withResolvers<undefined>();
    const child = probeChild();
    let diagnostic = "";
    child.kill.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("exit", null);
        child.emit("close", null);
      });
      return true;
    });
    mock.spawn.mockImplementation((_file: string, args: string[]) => {
      diagnostic = args[args.indexOf("-E") + 1] ?? "";
      ready.resolve(undefined);
      return child;
    });
    const abort = new AbortController();
    const work = expect(
      selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata, abort.signal),
    ).rejects.toMatchObject({ failure: "unreachable" });
    await ready.promise;
    if (mode === "abort") abort.abort();
    else if (mode === "timeout") await vi.advanceTimersByTimeAsync(10000);
    else if (mode === "spawn") child.emit("error", new Error("fixture spawn failure"));
    else if (mode === "stat") {
      vi.mocked(fs.fstatSync).mockImplementationOnce(() => {
        throw new Error("fixture stat failure");
      });
      await vi.advanceTimersByTimeAsync(10);
    } else child[mode === "stdout" ? "stdout" : "stderr"].write(Buffer.alloc(16385));
    await work;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(access(diagnostic)).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("Windows overflow uses the fixed OS tree terminator before removing the file", async () => {
  const f = await fixture();
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const systemRoot = join(tmpdir(), "fixture-windows");
  vi.stubEnv("SystemRoot", systemRoot);
  const child = Object.assign(probeChild(), { pid: 12345 });
  let diagnostic = "";
  mock.spawn.mockImplementation((_file: string, args: string[]) => {
    diagnostic = args[args.indexOf("-E") + 1] ?? "";
    void writeFile(diagnostic, Buffer.alloc(16385));
    return child;
  });
  child.kill.mockImplementation(() => {
    queueMicrotask(() => {
      child.emit("exit", null);
      child.emit("close", null);
    });
    return true;
  });
  mock.execFile.mockImplementation((file, args, _options, callback) => {
    expect(file).toBe(join(systemRoot, "System32", "taskkill.exe"));
    expect(args).toEqual(["/pid", "12345", "/T", "/F"]);
    callback(null, { stdout: "" });
  });
  await expect(
    selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata),
  ).rejects.toMatchObject({ failure: "unreachable" });
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  await expect(access(diagnostic)).rejects.toThrow();
});

test("cancelled probes and Windows without a trusted OS root never spawn SSH", async () => {
  const f = await fixture();
  const abort = new AbortController();
  abort.abort();
  await expect(
    selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata, abort.signal),
  ).rejects.toMatchObject({ failure: "unreachable" });
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.stubEnv("SystemRoot", "");
  await expect(
    selectHostArtifact({ host: "fixture" }, "0.1.0", f.root, f.metadata),
  ).rejects.toMatchObject({ failure: "unreachable" });
  expect(mock.spawn).not.toHaveBeenCalled();
});

test("build capability reads only sealed metadata, without SSH", async () => {
  expect(typeof (await remoteHostsAvailable())).toBe("boolean");
  const f = await fixture();
  mock.spawn.mockClear();
  for (const value of [
    null,
    {},
    { source: "bad", remoteHostsAvailable: true },
    { source: f.manifest.source },
    { source: f.manifest.source, remoteHostsAvailable: false },
  ]) {
    await writeFile(f.metadata, JSON.stringify(value));
    expect(await remoteHostsAvailable(f.metadata)).toBe(false);
  }
  await writeFile(f.metadata, "invalid json");
  expect(await remoteHostsAvailable(f.metadata)).toBe(false);
  await rm(f.metadata);
  expect(await remoteHostsAvailable(f.metadata)).toBe(false);
  await writeFile(
    f.metadata,
    JSON.stringify({ source: f.manifest.source, remoteHostsAvailable: true }),
  );
  expect(await remoteHostsAvailable(f.metadata)).toBe(true);
  expect(mock.spawn).not.toHaveBeenCalled();
});

test.each(["FOOM-LIBC-OK", "FOOM-LIBC-TOO-OLD", "FOOM-LIBC-UNSUPPORTED", "unexpected"])(
  "retains the platform SSH stream and consumes its libc observation: %s",
  async (libc) => {
    const f = await fixture();
    mock.execFile.mockClear();
    const child = probeChild();
    mock.spawn.mockImplementation(() => {
      queueMicrotask(() => child.stdout.write(`Linux\nx86_64\n${libc}\nFOOM-PROBED\n`));
      return child;
    });
    const retain = vi.fn();
    const observe = vi.fn();
    const output = vi.fn();
    try {
      const selected = selectHostArtifact(
        { host: "fixture" },
        "0.1.0",
        f.root,
        f.metadata,
        undefined,
        observe,
        output,
        retain,
      );
      if (libc === "FOOM-LIBC-OK")
        await expect(selected).resolves.toMatchObject({ platform: "linux" });
      else await expect(selected).rejects.toThrow();
      expect(retain).toHaveBeenCalledWith(child);
      expect(output).toHaveBeenCalledWith("Linux\nx86_64\n");
      expect(JSON.stringify(output.mock.calls)).not.toContain("FOOM-PROBED");
      expect(mock.spawn).toHaveBeenCalledTimes(1);
      expect(mock.execFile).not.toHaveBeenCalled();
    } finally {
      child.emit("exit", 0);
      child.emit("close", 0);
    }
  },
);

test.each(["Darwin\narm64\n", "Linux\nx86_64\nFOOM-LIBC-OK\nextra\nFOOM-PROBED\n"])(
  "a missing or malformed check prelude cannot fall back to another SSH connection: %j",
  async (stdout) => {
    const f = await fixture();
    const child = probeChild();
    mock.spawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write(stdout);
        child.emit("exit", 0);
        child.emit("close", 0);
      });
      return child;
    });
    const retain = vi.fn();
    await expect(
      selectHostArtifact(
        { host: "fixture" },
        "0.1.0",
        f.root,
        f.metadata,
        undefined,
        vi.fn(),
        undefined,
        retain,
      ),
    ).rejects.toThrow("Invalid check prelude");
    expect(retain).not.toHaveBeenCalled();
    expect(mock.spawn).toHaveBeenCalledTimes(1);
  },
);

test("retained SSH client diagnostics reach output before its exit is observed", async () => {
  const f = await fixture();
  const child = probeChild();
  let diagnostic = "";
  mock.spawn.mockImplementation((_file: string, args: string[]) => {
    diagnostic = args[args.indexOf("-E") + 1] ?? "";
    queueMicrotask(() => child.stdout.write("Linux\nx86_64\nFOOM-LIBC-OK\nFOOM-PROBED\n"));
    return child;
  });
  const output = vi.fn();
  await selectHostArtifact(
    { host: "fixture" },
    "0.1.0",
    f.root,
    f.metadata,
    undefined,
    vi.fn(),
    output,
    vi.fn(),
  );
  const text = "Fixture client connection reset\n";
  try {
    await writeFile(diagnostic, text);
    child.emit("exit", 255);
    expect(output).toHaveBeenCalledWith(text);
    expect(output.mock.calls.filter(([value]) => value === text)).toHaveLength(1);
  } finally {
    child.emit("close", 255);
  }
});
