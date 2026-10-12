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
  }
  refresh(now: number, state?: ShellState): void {
    if (this.platform === "win32") return;
    if (!state && now - this.last < 1000) return;
    this.last = now;
    if (state) {
      clearTimeout(this.timer);
      if (state.phase === "running") {
        // Bash emits PS0 before forking the job. One deferred lookup observes the
        // new foreground group even for silent programs such as sleep.
        this.timer = setTimeout(() => {
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
