import { join } from "node:path";
import { readOwnedFile } from "./providers/v2-files";
import { atomicPrivate, privateDirectory } from "../../node-common/private-files";
import { validAgentId } from "../../shared/providers/catalog";

/** Agent IDs only; no credentials, paths, screens or conversations are persisted. */
export class ProbeNotices {
  private work: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string) {}
  first(agent: string): Promise<boolean> {
    const task = this.work
      .catch(() => undefined)
      .then(async () => {
        const directory = await privateDirectory(this.root, "probe-notices");
        let seen: string[] = [];
        try {
          const input: unknown = JSON.parse(
            await readOwnedFile(join(directory, "seen.json"), 65536),
          );
          if (
            Array.isArray(input) &&
            input.length <= 1000 &&
            input.every((id): id is string => validAgentId(id))
          )
            seen = input;
        } catch {
          /* Missing or damaged metadata repeats the disclosure. */
        }
        if (seen.includes(agent)) return false;
        if (!validAgentId(agent) || seen.length >= 1000) return true;
        await atomicPrivate(directory, "seen.json", [...seen, agent]);
        return true;
      });
    this.work = task;
    return task;
  }
}
