import { randomUUID } from "node:crypto";
import type { ArmedConfirmation } from "../../shared/confirmation";

/** One expiring, single-use capability. The pending operation retains its own target. */
export class ConfirmationArming {
  private pending:
    | {
        arm: ArmedConfirmation;
        at: number;
        settle: (accepted: boolean) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private generation = 0;
  constructor(
    private readonly publish: (arm: ArmedConfirmation | null, accepted?: boolean) => void,
    private readonly now = () => performance.now(),
  ) {}
  begin(): number {
    this.cancel();
    return this.generation;
  }
  ask(generation: number, target: string, label: string): Promise<boolean> {
    if (generation !== this.generation) return Promise.resolve(false);
    this.finish(false);
    return new Promise((settle) => {
      const arm = { nonce: randomUUID(), target, label };
      this.pending = {
        arm,
        at: this.now(),
        settle,
        timer: setTimeout(() => {
          this.cancel();
        }, 3000),
      };
      this.publish(arm);
    });
  }
  confirm(nonce: unknown, target: unknown): boolean {
    const pending = this.pending;
    if (!pending || pending.arm.nonce !== nonce || pending.arm.target !== target) return false;
    const elapsed = this.now() - pending.at;
    if (elapsed < 300) return false;
    if (elapsed > 3000) {
      this.cancel();
      return false;
    }
    this.finish(true);
    return true;
  }
  cancel(): void {
    this.generation++;
    this.finish(false);
  }
  private finish(accepted: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    this.publish(null, accepted);
    pending.settle(accepted);
  }
}
