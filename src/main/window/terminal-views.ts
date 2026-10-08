/** Main-owned view reservations outlive renderer attachment (for example Settings). */
export class TerminalViews {
  private readonly owners = new Map<string, number>();

  owner(id: string): number | undefined {
    return this.owners.get(id);
  }

  /** Synchronous reservation: two racing windows cannot both acquire a terminal. */
  claim(id: string, window: number): boolean {
    const owner = this.owners.get(id);
    if (owner !== undefined && owner !== window) return false;
    this.owners.set(id, window);
    return true;
  }

  release(id: string, window: number): boolean {
    if (this.owners.get(id) !== window) return false;
    return this.owners.delete(id);
  }

  close(window: number): string[] {
    const released: string[] = [];
    for (const [id, owner] of this.owners)
      if (owner === window) {
        this.owners.delete(id);
        released.push(id);
      }
    return released;
  }

  snapshot(): { id: string; window: number }[] {
    return [...this.owners].map(([id, window]) => ({ id, window }));
  }
}
