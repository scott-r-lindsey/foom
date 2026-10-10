import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  buildLaunchEnvironment,
  EnvironmentStore,
  inheritedEnvironment,
  loginEnvironment,
  parseEnvironmentChange,
  safeStorageCipher,
} from "../../../../src/main/setup/environment";
import { IMPORTABLE } from "../../../../src/shared/environment-rules";

const dirs: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "foom-environment-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const cipher = {
  available: () => true,
  encrypt: (text: string) => Buffer.from(`enc:${text}`).reverse(),
  decrypt: (data: Buffer) => {
    const text = Buffer.from(data).reverse().toString();
    if (!text.startsWith("enc:")) throw new Error("Undecryptable");
    return text.slice(4);
  },
};
const change = (name: string, value: string | null, extra: object = {}) => ({
  scope: "all",
  previous: null,
  name,
  value,
  secret: false,
  ...extra,
});

test("a global proxy reaches shells and agents; agent layers override and stay their own", async () => {
  const store = await EnvironmentStore.open(await directory(), cipher, { windows: false });
  await store.save(change("HTTPS_PROXY", "http://proxy.corp:8080"));
  await store.save(change("SHARED", "global"));
  await store.save(change("SHARED", "codex", { scope: "codex" }));
  await store.save(change("CODEX_ONLY", "1", { scope: "codex" }));
  const base = { PATH: "/usr/bin", HOME: "/home/me" };
  const shell = buildLaunchEnvironment({ layers: store.layers("shell"), base, windows: false });
  const claude = buildLaunchEnvironment({ layers: store.layers("claude"), base, windows: false });
  const codex = buildLaunchEnvironment({ layers: store.layers("codex"), base, windows: false });
  for (const { env } of [shell, claude, codex])
    expect(env["HTTPS_PROXY"]).toBe("http://proxy.corp:8080");
  expect(shell.env["SHARED"]).toBe("global");
  expect(claude.env["SHARED"]).toBe("global");
  expect(codex.env["SHARED"]).toBe("codex");
  expect(claude.env["CODEX_ONLY"]).toBeUndefined();
  expect(codex.env["CODEX_ONLY"]).toBe("1");
  expect(shell.env["PATH"]).toBeUndefined();
  expect(codex.names.sort()).toEqual(
    ["CODEX_ONLY", "HTTPS_PROXY", "NO_PROXY", "SHARED", "no_proxy"].sort(),
  );
});

test("loopback joins NO_PROXY and no_proxy, keeping the user's entries, only with a proxy", () => {
  const proxied = buildLaunchEnvironment({
    layers: [[{ name: "NO_PROXY", value: ".corp, 10.0.0.0/8,localhost" }]],
    base: { HTTP_PROXY: "http://proxy:1", no_proxy: "internal" },
    windows: false,
  });
  expect(proxied.env["NO_PROXY"]).toBe("internal,.corp,10.0.0.0/8,localhost,127.0.0.1,::1");
  expect(proxied.env["no_proxy"]).toBe(proxied.env["NO_PROXY"]);
  const direct = buildLaunchEnvironment({ layers: [[{ name: "A", value: "1" }]], base: {} });
  expect(direct.env).toEqual({ A: "1" });
  // An empty agent value turns an inherited proxy off for that agent.
  const off = buildLaunchEnvironment({
    layers: [[{ name: "HTTPS_PROXY", value: "" }]],
    base: { HTTPS_PROXY: "http://proxy:1" },
    windows: false,
  });
  expect(off.env).toEqual({ HTTPS_PROXY: "" });
});

test("PATH layers only prepend, after Foom's directory; reserved variables win", () => {
  const { env, names } = buildLaunchEnvironment({
    layers: [[{ name: "PATH", value: "/global/a:/global/b" }], [{ name: "PATH", value: "/agent" }]],
    base: { PATH: "/usr/bin" },
    path: "/login/bin",
    pathFirst: "/foom/cli",
    foom: { FOOM_SESSION: "s" },
    windows: false,
  });
  expect(env["PATH"]).toBe("/foom/cli:/agent:/global/a:/global/b:/login/bin");
  expect(env["FOOM_SESSION"]).toBe("s");
  expect(names).toEqual(["PATH"]);
  expect(
    buildLaunchEnvironment({ layers: [], base: { PATH: "/usr/bin" }, path: "/login" }).env,
  ).toEqual({ PATH: "/login" });
});

test("launch validates every variable again", () => {
  for (const layer of [
    [{ name: "FOOM_TOKEN", value: "x" }],
    [{ name: "NODE_OPTIONS", value: "--require x" }],
    [{ name: "PATH", value: "relative" }],
    [{ name: "HTTPS_PROXY", value: "proxy:8080" }],
  ])
    expect(() => buildLaunchEnvironment({ layers: [layer], base: {}, windows: false })).toThrow();
});

test("Windows names are case-insensitive and reuse the inherited spelling", async () => {
  const { env, names } = buildLaunchEnvironment({
    layers: [
      [
        { name: "https_proxy", value: "http://p:1" },
        { name: "PATH", value: "C:\\Tools" },
      ],
    ],
    base: { Path: "C:\\Windows", HTTPS_PROXY: "http://old:1", No_Proxy: "corp" },
    windows: true,
  });
  expect(env).toEqual({
    HTTPS_PROXY: "http://p:1",
    Path: "C:\\Tools;C:\\Windows",
    No_Proxy: "corp,localhost,127.0.0.1,::1",
  });
  expect(names).toEqual(["HTTPS_PROXY", "Path", "No_Proxy"]);
  const store = await EnvironmentStore.open(await directory(), cipher, { windows: true });
  await store.save(change("Proxy_Name", "1"));
  await expect(store.save(change("PROXY_NAME", "2"))).rejects.toThrow("already in this list");
  expect((await store.remove("all", "proxy_name")).lists.all).toEqual([]);
});

test("secrets are encrypted at rest, masked in replies, renamed without reading, and redacted", async () => {
  const dir = await directory();
  const store = await EnvironmentStore.open(dir, cipher, { windows: false });
  const state = await store.save(change("HTTPS_PROXY", "http://sam:hunter2@proxy:3128"));
  expect(state.lists.all).toEqual([{ name: "HTTPS_PROXY", value: null, secret: true }]);
  await store.save(change("API_TOKEN", "tok-123456", { secret: true }));
  await store.save(change("API_KEY", null, { previous: "API_TOKEN", secret: true }));
  await expect(store.save(change("API_KEY", null, { previous: "API_KEY" }))).rejects.toThrow(
    "Enter a value",
  );
  await expect(store.save(change("NEW", null))).rejects.toThrow("Enter a value");
  const file = await readFile(path.join(dir, "environment.json"), "utf8");
  expect(file).not.toContain("hunter2");
  expect(file).not.toContain("tok-123456");
  expect(JSON.stringify(store.state())).not.toContain("hunter2");
  expect(store.redactions()).toEqual(
    expect.arrayContaining([
      "http://sam:hunter2@proxy:3128",
      "sam:hunter2",
      "hunter2",
      "tok-123456",
    ]),
  );
  const reopened = await EnvironmentStore.open(dir, cipher, { windows: false });
  expect(reopened.layers("shell")).toEqual([
    [
      { name: "HTTPS_PROXY", value: "http://sam:hunter2@proxy:3128" },
      { name: "API_KEY", value: "tok-123456" },
    ],
  ]);
});

test("secrets are refused without OS encryption, and a failed write changes nothing", async () => {
  const dir = await directory();
  const unavailable = { ...cipher, available: () => false };
  const store = await EnvironmentStore.open(dir, unavailable, { windows: false });
  expect(store.state().secrets).toBe(false);
  await expect(store.save(change("A", "x", { secret: true }))).rejects.toThrow("keychain");
  await expect(store.save(change("P", "http://u:p@h:1"))).rejects.toThrow("keychain");
  expect(store.state().lists.all).toEqual([]);
  await store.save(change("A", "plain"));
  expect(store.state().lists.all).toEqual([{ name: "A", value: "plain", secret: false }]);
  await rm(dir, { recursive: true });
  await writeFile(dir, "not a directory");
  await expect(store.save(change("B", "x"))).rejects.toThrow();
  expect(store.state().lists.all).toHaveLength(1);
});

test("loading drops invalid, duplicate, plain-credential and undecryptable rows", async () => {
  const dir = await directory();
  await writeFile(
    path.join(dir, "environment.json"),
    JSON.stringify({
      version: 1,
      lists: {
        all: [
          { name: "GOOD", value: "1" },
          { name: "GOOD", value: "2" },
          { name: "LD_PRELOAD", value: "/x.so" },
          { name: "LEAK", value: "http://u:p@h:1" },
          { name: "BROKEN", secret: true, cipher: "AAAA" },
          { name: "NUMBER", value: 3 },
          "nonsense",
        ],
        codex: "nonsense",
        claude: [{ name: "S", secret: true, cipher: cipher.encrypt("v").toString("base64") }],
      },
    }),
  );
  const store = await EnvironmentStore.open(dir, cipher, { windows: false });
  expect(store.state().lists).toEqual({
    all: [{ name: "GOOD", value: "1", secret: false }],
    claude: [{ name: "S", value: null, secret: true }],
    codex: [],
    agy: [],
  });
  const locked = await EnvironmentStore.open(dir, { ...cipher, available: () => false });
  expect(locked.state().lists.claude).toEqual([]);
  await writeFile(path.join(dir, "environment.json"), "{");
  expect((await EnvironmentStore.open(dir, cipher)).state().lists.all).toEqual([]);
  await writeFile(path.join(dir, "environment.json"), JSON.stringify({ version: 2, lists: {} }));
  expect((await EnvironmentStore.open(dir, cipher)).state().lists.all).toEqual([]);
});

test("edits replace in place, refuse stale rows and full lists, and serialize", async () => {
  const dir = await directory();
  const store = await EnvironmentStore.open(dir, cipher, { windows: false });
  await Promise.all([store.save(change("A", "1")), store.save(change("B", "2"))]);
  await store.save(change("A2", "3", { previous: "A" }));
  expect(store.state().lists.all.map((row) => row.name)).toEqual(["A2", "B"]);
  await expect(store.save(change("C", "1", { previous: "GONE" }))).rejects.toThrow(
    "GONE is no longer in this list",
  );
  await expect(store.save(change("B", "1"))).rejects.toThrow("B is already in this list");
  for (let index = 2; index < 64; index++) await store.save(change(`V${String(index)}`, "x"));
  await expect(store.save(change("FULL", "x"))).rejects.toThrow("at most 64");
  expect((await readdir(dir)).filter((file) => file.endsWith(".tmp"))).toEqual([]);
});

test("import offers only valid proxy and certificate variables and adds only picked ones", async () => {
  const read = vi.fn(() =>
    Promise.resolve({
      HTTPS_PROXY: "http://me:pw@proxy:8080",
      https_proxy: "http://other:1",
      HTTP_PROXY: "not a url",
      NO_PROXY: ".corp",
      SSL_CERT_FILE: "/certs/root.pem",
      AWS_SECRET_ACCESS_KEY: "never",
    }),
  );
  const store = await EnvironmentStore.open(await directory(), cipher, { windows: true, read });
  await store.save(change("NO_PROXY", ".corp"));
  await store.save(change("SSL_CERT_FILE", "/old.pem"));
  await expect(store.import(["HTTPS_PROXY"])).rejects.toThrow("Read the login shell again");
  expect(await store.readShell()).toEqual([
    { name: "HTTPS_PROXY", display: "http://me:••••@proxy:8080", status: "new" },
    { name: "NO_PROXY", display: ".corp", status: "same" },
    { name: "SSL_CERT_FILE", display: "/certs/root.pem", status: "replaces" },
  ]);
  await expect(store.import(["AWS_SECRET_ACCESS_KEY"])).rejects.toThrow("Read the login shell");
  await expect(store.import("HTTPS_PROXY")).rejects.toThrow("Invalid import");
  const state = await store.import(["HTTPS_PROXY", "SSL_CERT_FILE"]);
  expect(state.lists.all).toEqual([
    { name: "NO_PROXY", value: ".corp", secret: false },
    { name: "SSL_CERT_FILE", value: "/certs/root.pem", secret: false },
    { name: "HTTPS_PROXY", value: null, secret: true },
  ]);
  await expect(store.import(["NO_PROXY"])).rejects.toThrow("Read the login shell again");
  read.mockRejectedValueOnce(new Error("secret detail"));
  await expect(store.readShell()).rejects.toThrow("Unable to read the login shell");
});

test("the login shell runs one fixed program and only importable names come back", async () => {
  const run = vi.fn(
    (_file: string, args: readonly string[], _options: object): Promise<{ stdout: string }> => {
      expect(args[0]).toBe("-ilc");
      expect(args[1]).not.toMatch(/AWS|PATH/);
      const values = IMPORTABLE.map((name) => (name === "HTTPS_PROXY" ? "http://p:1" : ""));
      return Promise.resolve({ stdout: `motd\0FOOM_ENV\0${values.join("\0")}\0` });
    },
  );
  if (process.platform !== "win32")
    expect(await loginEnvironment(run, "linux")).toEqual({ HTTPS_PROXY: "http://p:1" });
  run.mockResolvedValueOnce({ stdout: "no marker" });
  if (process.platform !== "win32") await expect(loginEnvironment(run, "linux")).rejects.toThrow();
  expect(
    await loginEnvironment(run, "win32", { https_proxy: "http://w:1", OTHER: "x", NO_PROXY: "" }),
  ).toEqual({ HTTPS_PROXY: "http://w:1" });
});

test("helpers: change parsing, inherited scrub and the safeStorage adapter", () => {
  expect(() => parseEnvironmentChange({ ...change("A", "1"), name: 1 })).toThrow();
  expect(() =>
    parseEnvironmentChange({ ...change("A", "1"), previous: "x".repeat(300) }),
  ).toThrow();
  expect(parseEnvironmentChange(change("A", null, { previous: "B" }))).toMatchObject({
    previous: "B",
    value: null,
  });
  expect(
    inheritedEnvironment({ A: "1", npm_x: "2", ELECTRON_RUN: "3", FOOM_X: "4", CLAUDECODE: "1" }),
  ).toEqual({ A: "1" });
  const storage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "basic_text",
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (data: Buffer) => data.toString(),
  };
  const adapter = safeStorageCipher(storage);
  expect(adapter.available()).toBe(process.platform !== "linux");
  expect(
    safeStorageCipher({
      ...storage,
      getSelectedStorageBackend: () => "gnome_libsecret",
    }).available(),
  ).toBe(true);
  expect(adapter.decrypt(adapter.encrypt("x"))).toBe("x");
});
