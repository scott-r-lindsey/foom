import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile, rm } from "node:fs/promises";
import type { CodexHookState } from "../../shared/agents";
import { codexHookArguments, codexObserverCommand } from "./codex-hooks";

/** Foom's observed health, never Codex's trust store. Only Codex can grant trust. */
export class CodexHookStatus {
  private state: CodexHookState = "not-reviewed";
  private writes: Promise<void> = Promise.resolve();
  private readonly fingerprint: string;
  private latestLaunch = 0;
  constructor(
    private readonly file?: string,
    command = codexObserverCommand(),
  ) {
    this.fingerprint = createHash("sha256")
      .update(JSON.stringify(codexHookArguments(command)))
      .digest("hex");
  }
  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const data: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (
        typeof data !== "object" ||
        data === null ||
        !("fingerprint" in data) ||
        !("state" in data)
      )
        return;
      if (data.fingerprint !== this.fingerprint) this.state = "outdated";
      else if (
        data.state === "trusted" ||
        data.state === "declined" ||
        data.state === "not-reviewed" ||
        data.state === "outdated"
      )
        this.state = data.state;
    } catch {
      /* Missing or corrupt Foom health data keeps notify enabled. */
    }
  }
  get(): CodexHookState {
    return this.state;
  }
  begin(): number {
    return ++this.latestLaunch;
  }
  set(state: CodexHookState, launch = this.latestLaunch): void {
    if (launch !== this.latestLaunch || this.state === state) return;
    this.state = state;
    const file = this.file;
    if (!file) return;
    const data = JSON.stringify({ fingerprint: this.fingerprint, state });
    this.writes = this.writes
      .then(async () => {
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
          await rename(temporary, file);
        } finally {
          await rm(temporary, { force: true });
        }
      })
      .catch(() => {
        /* Health persistence failure cannot stop an agent. */
      });
  }
  flush(): Promise<void> {
    return this.writes;
  }
}
