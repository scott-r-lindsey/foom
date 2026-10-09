export interface PanelTarget {
  id: string;
  anchor: HTMLElement;
  pinned: boolean;
}
/** One intent machine per sidebar; all delayed work is cancelled on disposal. */
export class PanelIntent {
  private current: PanelTarget | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dragging = false;
  private listeners = new Set<() => void>();
  getSnapshot = () => this.current;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private publish(value: PanelTarget | undefined) {
    this.current = value;
    for (const listener of this.listeners) listener();
  }
  enter(id: string, anchor: HTMLElement) {
    if (this.dragging || this.current?.pinned) return;
    this.cancel();
    if (this.current?.id === id) return;
    this.timer = setTimeout(
      () => {
        this.publish({ id, anchor, pinned: false });
      },
      this.current ? 120 : 400,
    );
  }
  leave() {
    this.cancel();
    if (!this.current?.pinned)
      this.timer = setTimeout(() => {
        this.close();
      }, 250);
  }
  hold() {
    this.cancel();
  }
  pin(id: string, anchor: HTMLElement) {
    if (this.dragging || (this.current?.pinned && this.current.id !== id)) return;
    this.cancel();
    this.publish({ id, anchor, pinned: true });
  }
  close = () => {
    this.cancel();
    const previous = this.current;
    this.publish(undefined);
    if (previous?.pinned) previous.anchor.focus({ preventScroll: true });
  };
  drag(active: boolean) {
    this.dragging = active;
    if (active) this.close();
  }
  dispose() {
    this.cancel();
    this.listeners.clear();
  }
}
