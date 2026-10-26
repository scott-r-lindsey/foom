import { forgeBranch } from "../control/forge";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { absolutePath, record } from "./worktree-operations";
import type { WorktreeStoredState } from "./worktree-state.d";

/** Persisted records are claims only; the service validates them against live Git. */
export class WorktreeStore {
  private pendingSave: Promise<void> = Promise.resolve();
  constructor(private readonly stateFile: string) {}
  async read(): Promise<WorktreeStoredState | undefined> {
    let state: unknown;
    try {
      state = JSON.parse(await readFile(this.stateFile, "utf8"));
    } catch {
      // Missing, unreadable or corrupt state never grants ownership or blocks startup.
      return undefined;
    }
    if (
      !record(state) ||
      state["version"] !== 1 ||
      !Array.isArray(state["repositories"]) ||
      !Array.isArray(state["managed"])
    )
      return undefined;

    return {
      version: 1,
      repositories: state["repositories"].filter(absolutePath),
      managed: state["managed"]
        .filter(
          (entry): entry is WorktreeStoredState["managed"][number] =>
            record(entry) &&
            absolutePath(entry["path"]) &&
            absolutePath(entry["repository"]) &&
            absolutePath(entry["root"]) &&
            typeof entry["identity"] === "string",
        )
        .map((entry) => {
          const review: unknown = entry.review;
          return {
            path: entry.path,
            repository: entry.repository,
            root: entry.root,
            identity: entry.identity,
            ...(record(review) &&
            forgeBranch(review["branch"]) &&
            typeof review["head"] === "string" &&
            /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(review["head"]) &&
            typeof review["refs"] === "string" &&
            review["refs"].length <= 1024 * 1024
              ? { review: { head: review["head"], branch: review["branch"], refs: review["refs"] } }
              : {}),
          };
        }),
    };
  }
  async save(snapshot: () => WorktreeStoredState): Promise<void> {
    const stateFile = this.stateFile;
    const save = this.pendingSave
      .catch(() => undefined)
      .then(async () => {
        const contents = JSON.stringify(snapshot());
        await mkdir(dirname(stateFile), { recursive: true });
        const temporary = `${stateFile}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
          await rename(temporary, stateFile);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    this.pendingSave = save;
    await save;
  }
}
