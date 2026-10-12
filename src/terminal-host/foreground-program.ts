import { basename } from "node:path";
import { foregroundName } from "../shared/foreground-name";
import type { ShellState } from "../shared/desktop";

/** Output-driven refreshes only: there is no idle polling timer. */
export class ForegroundProgram {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last = -Infinity;
  private value = "";
  constructor(
    private readonly command: string,
    private readonly read: () => string,
    private readonly publish: (name: string) => void,
    private readonly platform = process.platform,
  ) {}
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  refresh(now: number, state?: ShellState): void {
    if (this.platform === "win32") return;
    if (!state && now - this.last < 1000) {
      // A final prompt may be the only output after a short foreground job.
      // Coalesce it into one trailing lookup; never poll a silent terminal.
      this.timer ??= setTimeout(
        () => {
          this.timer = undefined;
          this.refresh(Date.now());
        },
        1000 - (now - this.last),
      );
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.last = now;
    if (state) {
      if (state.phase === "running") {
        // Bash emits PS0 before forking the job. One deferred lookup observes the
        // new foreground group even for silent programs such as sleep.
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.last = -Infinity;
          this.refresh(Date.now());
        }, 100);
      }
    }
    let name = "";
    try {
      if (state?.phase !== "prompt") name = foregroundName(basename(this.read()));
    } catch {
      /* The process may exit between output and the native lookup. */
    }
    if (name === basename(this.command)) name = "";
    if (name !== this.value) {
      this.value = name;
      this.publish(name);
    }
  }
}
