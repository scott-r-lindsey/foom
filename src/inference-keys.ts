import { safeStorage } from "electron";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ApiProvider } from "./shared/inference";

/** Main only. No IPC read capability; never expose this service to preload. */
export class InferenceKeys {
  constructor(private readonly userData: string) {}

  private file(provider: ApiProvider): string {
    if (!["anthropic", "openai", "google"].includes(provider))
      throw new Error("Invalid key provider");
    return path.join(this.userData, `inference-${provider}.key`);
  }
  private requireEncryption(): void {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")
    ) {
      throw new Error("Secure key storage unavailable; use a local endpoint or rules only");
    }
  }
  async set(provider: ApiProvider, value: unknown): Promise<void> {
    const file = this.file(provider);
    if (typeof value !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(value))
      throw new Error("Invalid API key");
    this.requireEncryption();
    const ciphertext = safeStorage.encryptString(value);
    await mkdir(this.userData, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, ciphertext, { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async get(provider: ApiProvider): Promise<string> {
    const file = this.file(provider);
    this.requireEncryption();
    return safeStorage.decryptString(await readFile(file));
  }
  async remove(provider: ApiProvider): Promise<void> {
    await rm(this.file(provider), { force: true });
  }
}
