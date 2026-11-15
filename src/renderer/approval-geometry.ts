/** A moved decision needs a fresh, monotonic reading interval, including after scrolling. */
export class ApprovalGeometry {
  private readonly controls = new Map<Element, { id: string; rect: DOMRect; readyAt: number }>();
  constructor(private readonly now = () => performance.now()) {}
  read(root: Element): { blocked: readonly string[]; delay: number } {
    const now = this.now();
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
  ready(root: Element, id: string): boolean {
    const { blocked } = this.read(root);
    return (
      !blocked.includes(id) && [...this.controls.values()].some((control) => control.id === id)
    );
  }
}
