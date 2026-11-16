/** A moved decision needs a fresh, monotonic reading interval, including after scrolling. */
export class ApprovalGeometry {
  private readonly controls = new Map<Element, { id: string; rect: DOMRect; readyAt: number }>();
  private revision = 0;
  constructor(private readonly now = () => performance.now()) {}
  read(root: Element, revision = 0): { blocked: readonly string[]; delay: number } {
    const now = this.now();
    const nativeMoved = revision !== this.revision;
    this.revision = revision;
    const live = new Set(root.querySelectorAll("button[data-approval-decision]"));
    for (const element of this.controls.keys())
      if (!live.has(element)) this.controls.delete(element);
    const blocked = new Set<string>();
    let delay = Infinity;
    for (const element of live) {
      const id = element.getAttribute("data-approval-decision") ?? "";
      const rect = element.getBoundingClientRect();
      const previous = this.controls.get(element);
      const moved =
        nativeMoved ||
        !previous ||
        rect.x !== previous.rect.x ||
        rect.y !== previous.rect.y ||
        rect.width !== previous.rect.width ||
        rect.height !== previous.rect.height;
      const readyAt = moved ? now + 900 : previous.readyAt;
      this.controls.set(element, { id, rect, readyAt });
      if (readyAt > now) {
        blocked.add(id);
        delay = Math.min(delay, readyAt - now);
      }
    }
    return { blocked: [...blocked], delay };
  }
  ready(root: Element, id: string, revision = 0): boolean {
    const { blocked } = this.read(root, revision);
    return (
      !blocked.includes(id) && [...this.controls.values()].some((control) => control.id === id)
    );
  }
}
