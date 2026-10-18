import { open } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivate, privateDirectory, verifyPrivate } from "../control/private-files";

/** Profile-only answers are independent of config manifests and config git. */
export class SetupOffers {
  private readonly answers = new Set<string>();
  private directory: string | undefined;
  private saving = Promise.resolve();
  async load(profile: string): Promise<void> {
    this.directory = await privateDirectory(profile, "agent-setup");
    this.answers.clear();
    const target = join(this.directory, "offers.json");
    try {
      await verifyPrivate(target, false);
      const file = await open(target, "r");
      try {
        const bytes = Buffer.alloc(16385);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 16384) return;
        const value: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)),
        );
        if (
          !Array.isArray(value) ||
          value.length > 100 ||
          !value.every(
            (id: unknown) => typeof id === "string" && /^[a-z][a-z0-9-]{0,39}$/u.test(id),
          )
        )
          return;
        for (const id of value) this.answers.add(String(id));
      } finally {
        await file.close();
      }
    } catch {
      /* Missing or malformed private state grants no answer or authority. */
    }
  }
  answered(id: string): boolean {
    return this.answers.has(id);
  }
  async answer(id: string): Promise<void> {
    if (!this.directory) return;
    const directory = this.directory;
    const saving = this.saving
      .catch(() => undefined)
      .then(async () => {
        const answers = [...this.answers].filter((entry) => entry !== id).slice(-99);
        answers.push(id);
        await atomicPrivate(directory, "offers.json", answers);
        this.answers.add(id);
      });
    this.saving = saving;
    await saving;
  }
}
export const setupOffers = new SetupOffers();
