import type { ChildEvents } from "./child-events";

/** Subscription and disposal only; each consumer owns its own state. */
export class OrchestrationAutomation {
  private readonly off: () => void;

  constructor(
    events: ChildEvents,
    sync: () => void,
    private readonly cleanup: () => void,
  ) {
    this.off = events.subscribe(sync);
  }

  dispose(): void {
    this.off();
    this.cleanup();
  }
}
