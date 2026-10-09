import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateConfig } from "../../../src/cli/config";
import { execute } from "../../../src/cli/execute";
import { interfaceThemes } from "../../../src/shared/interface-themes";
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foom-config-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function put(root: string, name: string, value: string | Uint8Array) {
  const file = join(root, name);
  await writeFile(file, value);
  return file;
}
function wav(seconds: number) {
  const bytes = Buffer.alloc(44 + Math.round(seconds * 8000) * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
test("validates individual files, reports content failures and I/O exit codes", async () => {
  const root = await fixture();
  const file = await put(root, "input.json", '{"kind":"settings"}');
  expect(await validateConfig(file)).toEqual({ problems: [], code: 0 });
  await writeFile(file, Buffer.from([0xff]));
  expect(await validateConfig(file)).toMatchObject({
    code: 1,
    problems: [{ reason: "malformed-json" }],
  });
  await writeFile(file, "{");
  expect(await validateConfig(file)).toEqual({
    problems: [{ file: "input.json", path: "$", reason: "malformed-json" }],
    code: 1,
  });
  await writeFile(file, " ".repeat(65537));
  expect(await validateConfig(file)).toMatchObject({
    code: 1,
    problems: [{ reason: "too-large" }],
  });
  expect(await validateConfig(join(root, "missing"))).toMatchObject({
    code: 2,
    problems: [{ reason: "unreadable" }],
  });
});
test("walks only the config layout, checks kind placement and rejects unexpected files/directories", async () => {
  const root = await fixture();
  await put(root, "settings.json", '{"kind":"settings"}');
  await mkdir(join(root, "themes"));
  await mkdir(join(root, "terminal-themes"));
  await mkdir(join(root, "sounds"));
  await mkdir(join(root, "sounds", "done"));
  const theme = interfaceThemes["eclipse-dark"];
  await put(
    join(root, "themes"),
    "mine.json",
    JSON.stringify({ kind: "theme", name: theme.name, base: theme.base, colors: theme.colors }),
  );
  await put(join(root, "sounds", "done"), "tone.wav", wav(0.1));
  expect(await validateConfig(root)).toEqual({ problems: [], code: 0 });
  await put(join(root, "terminal-themes"), "wrong.json", '{"kind":"settings"}');
  expect(await validateConfig(root)).toMatchObject({
    code: 1,
    problems: [{ file: "terminal-themes/wrong.json", path: "$.kind" }],
  });
  await put(join(root, "themes"), ".hidden", "{}");
  await mkdir(join(root, "themes", "nested.json"));
  await mkdir(join(root, "sounds", "unknown"));
  expect((await validateConfig(root)).problems).toHaveLength(4);
  await rm(join(root, "terminal-themes"), { recursive: true });
  await rm(join(root, "sounds"), { recursive: true });
  await put(root, "unknown", "secret");
  expect((await validateConfig(root)).problems.some((problem) => problem.file === "unknown")).toBe(
    true,
  );
});
test("caps folder counts including unexpected entries", async () => {
  const root = await fixture();
  const themes = join(root, "themes");
  await mkdir(themes);
  await Promise.all(
    Array.from({ length: 51 }, (_, index) =>
      put(themes, `${String(index)}.json`, '{"kind":"theme"}'),
    ),
  );
  expect((await validateConfig(themes)).problems).toContainEqual({
    file: "",
    path: "$",
    reason: "too-many-files",
  });
  const done = join(root, "done");
  await mkdir(done);
  await Promise.all(
    Array.from({ length: 101 }, (_, index) => put(done, `${String(index)}.wav`, wav(0.1))),
  );
  expect((await validateConfig(done)).problems).toContainEqual({
    file: "",
    path: "$",
    reason: "too-many-files",
  });
});
test("rejects symlink files and redirected folders without reading their target", async () => {
  const root = await fixture();
  const outside = await fixture();
  const target = await put(outside, "secret.json", "SECRET");
  await symlink(target, join(root, "settings.json"));
  await symlink(outside, join(root, "themes"), process.platform === "win32" ? "junction" : "dir");
  const result = await validateConfig(root);
  expect(result).toMatchObject({ code: 1 });
  expect(result.problems.map((p) => p.reason)).toEqual(["unsafe-file", "unsafe-file"]);
  expect(await validateConfig(join(root, "settings.json"))).toMatchObject({
    code: 1,
    problems: [{ reason: "unsafe-file" }],
  });
});
test("validates sound filenames, headers, size and shared duration boundaries offline", async () => {
  const root = await fixture();
  for (const kind of ["working", "done", "needs-you", "refusal"]) {
    const directory = join(root, kind);
    await mkdir(directory);
    const file = await put(directory, "tone.wav", wav(kind === "working" ? 1 : 0.1));
    expect(await validateConfig(file)).toEqual({ problems: [], code: 0 });
    await writeFile(file, wav(kind === "working" ? 0.5 : 2));
    expect(await validateConfig(file)).toMatchObject({
      code: 1,
      problems: [{ reason: "invalid-value" }],
    });
  }
  const directory = join(root, "done");
  for (const [name, bytes] of [
    ["bad.wav", Buffer.from("bad")],
    ["header.wav", Buffer.from("RIFF0000WAVE")],
    ["too-big.wav", Buffer.alloc(2 * 1024 * 1024 + 1)],
    [".hidden.wav", wav(0.1)],
  ] as const) {
    const file = await put(directory, name, bytes);
    expect((await validateConfig(file)).code).toBe(1);
  }
  await copyFile("src/sounds/done/typewriter-bell.ogg", join(directory, "real.ogg"));
  expect(await validateConfig(join(directory, "real.ogg"))).toEqual({ problems: [], code: 0 });
});
test("execute bypasses inherited credentials, pairing and profile discovery and preserves JSON/text parity", async () => {
  const root = await fixture();
  const file = await put(root, "input.json", '{"kind":"settings","agentArguments":{}}');
  const out = vi.fn();
  const error = vi.fn();
  const io = {
    out,
    error,
    input: (async function* () {
      yield await Promise.resolve("");
    })(),
  };
  const env = {
    FOOM_CONTROL_URL: "bad",
    FOOM_CONTROL_TOKEN: "secret",
    FOOM_CONTROL_INSTANCE: "bad",
    HOME: join(root, "missing"),
  };
  expect(await execute(["config", "validate", file, "--json"], "1", io, env, "/foom")).toBe(1);
  expect(out).toHaveBeenLastCalledWith(
    '[{"file":"input.json","path":"$.agentArguments","reason":"unknown-key"}]\n',
  );
  expect(await execute(["config", "validate", file], "1", io, env, "/foom")).toBe(1);
  expect(out).toHaveBeenLastCalledWith('"input.json": $.agentArguments: unknown-key\n');
  expect(error).not.toHaveBeenCalled();
  for (const args of [
    ["config"],
    ["config", "other", file],
    ["config", "validate"],
    ["config", "validate", ""],
    ["config", "validate", "--bad"],
    ["config", "validate", "bad\0path"],
    ["config", "validate", file, "extra"],
  ])
    expect(await execute(args, "1", io, env, "/foom")).toBe(2);
  await writeFile(file, '{"kind":"settings"}');
  expect(await execute(["config", "validate", file, "--json"], "1", io, env, "/foom")).toBe(0);
  expect(out).toHaveBeenLastCalledWith("[]\n");
  expect(await execute(["config", "validate", join(root, "absent")], "1", io, env, "/foom")).toBe(
    2,
  );
});
