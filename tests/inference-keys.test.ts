import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  getSelectedStorageBackend: vi.fn(() => "gnome_libsecret"),
  encryptString: vi.fn((_text: string) => Buffer.from("ciphertext")),
  decryptString: vi.fn((_buffer: Buffer) => "private-key"),
}));
vi.mock("electron", () => ({ safeStorage: storage }));
import { InferenceKeys } from "../src/inference-keys";
const dirs: string[] = [];
async function directory() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "foom-keys-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
it("stores only encrypted bytes with private permissions and round trips via safeStorage", async () => {
  const dir = await directory();
  const keys = new InferenceKeys(dir);
  await keys.set("openai", "private-key");
  const file = path.join(dir, "inference-openai.key");
  expect(await readFile(file, "utf8")).toBe("ciphertext");
  expect(storage.encryptString).toHaveBeenCalledWith("private-key");
  expect(await keys.get("openai")).toBe("private-key");
  expect(storage.decryptString).toHaveBeenCalledWith(Buffer.from("ciphertext"));
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  await keys.set("openai", "replacement");
  expect(await readdir(dir)).toEqual(["inference-openai.key"]);
  await keys.remove("openai");
  await keys.remove("openai");
  expect(await readdir(dir)).toEqual([]);
});
it("refuses unavailable encryption, insecure Linux fallback, invalid providers and key input", async () => {
  const dir = await directory();
  const keys = new InferenceKeys(dir);
  storage.isEncryptionAvailable.mockReturnValueOnce(false);
  await expect(keys.set("google", "private-key")).rejects.toThrow("Secure key storage");
  if (process.platform === "linux") {
    storage.getSelectedStorageBackend.mockReturnValueOnce("basic_text");
    await expect(keys.get("google")).rejects.toThrow("Secure key storage");
  }
  for (const value of [null, "", "key\nsecret", " ", "x".repeat(4097)])
    await expect(keys.set("anthropic", value)).rejects.toThrow("Invalid API key");
  await expect(Reflect.apply(keys.set.bind(keys), keys, ["../escape", "key"])).rejects.toThrow(
    "Invalid key provider",
  );
  expect(await readdir(dir)).toEqual([]);
});
it("preserves previous keys when encryption fails, and reports missing or corrupt storage", async () => {
  const dir = await directory();
  const keys = new InferenceKeys(dir);
  await keys.set("openai", "private-key");
  storage.encryptString.mockImplementationOnce(() => {
    throw new Error("encryption failed");
  });
  await expect(keys.set("openai", "new")).rejects.toThrow();
  expect(await readFile(path.join(dir, "inference-openai.key"), "utf8")).toBe("ciphertext");
  storage.decryptString.mockImplementationOnce(() => {
    throw new Error("corrupt");
  });
  await expect(keys.get("openai")).rejects.toThrow();
  await expect(keys.get("anthropic")).rejects.toThrow();
  const bad = path.join(dir, "file");
  await writeFile(bad, "not a directory");
  await expect(new InferenceKeys(bad).set("google", "key")).rejects.toThrow();
});
it("cleans the temporary ciphertext if replacement fails", async () => {
  const dir = await directory();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(dir, "inference-openai.key"));
  await expect(new InferenceKeys(dir).set("openai", "key")).rejects.toThrow();
  expect(await readdir(dir)).toEqual(["inference-openai.key"]);
});
