import type { GithubSignInState } from "../../shared/registered-hosts.d";

/** Window-owned capability: only IDs created by its explicit gh sign-in qualify. */
export class GithubSignIn {
  private readonly sessions = new Map<
    string,
    {
      state: GithubSignInState;
      active: boolean;
      cancelled: boolean;
      actions: Map<"copy" | "open", Promise<void>>;
      off?: () => void;
      dirty: boolean;
      pending?: Promise<void> | undefined;
    }
  >();
  constructor(
    private readonly effects: {
      observe(id: string, listener: () => void): () => void;
      screen(id: string): Promise<{ lines: string[] }>;
      copy(code: string): void | Promise<void>;
      clipboard(): string | Promise<string>;
      clear(): void | Promise<void>;
      open(): Promise<void>;
      stop(id: string): Promise<void>;
    },
  ) {}

  start(id: string): void {
    if (this.sessions.has(id)) return;
    for (const [key, session] of this.sessions) {
      if (this.sessions.size < 256) break;
      if (!session.active) this.sessions.delete(key);
    }
    if (this.sessions.size >= 256) throw new Error("Too many sign-ins");
    const state: GithubSignInState = { phase: "starting", copied: false, opened: false };
    const session = {
      state,
      active: true,
      cancelled: false,
      actions: new Map<"copy" | "open", Promise<void>>(),
      dirty: false,
      off: this.effects.observe(id, () => {
        this.refresh(id);
      }),
    };
    this.sessions.set(id, session);
    this.refresh(id);
  }
  private refresh(id: string): void {
    const session = this.sessions.get(id);
    if (!session?.active) return;
    if (session.pending) {
      session.dirty = true;
      return;
    }
    session.dirty = false;
    session.pending = this.inspect(id)
      .catch(() => {})
      .finally(() => {
        session.pending = undefined;
        if (session.active && session.dirty) this.refresh(id);
      });
  }
  private active(id: string): boolean {
    return this.sessions.get(id)?.active === true;
  }
  private async inspect(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session?.active) return;
    const { lines } = await this.effects.screen(id);
    if (!this.active(id)) return;
    if (session.state.code) {
      if (lines.some((line) => line.includes("Authentication complete")))
        session.state.phase = "finishing";
      return;
    }
    // Parsed, bounded headless cells, never a URL or arbitrary clipboard payload.
    const text = lines.join("\n");
    const match =
      /(?:^|\n)[! ]*First copy your one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})(?:\s|$)/u.exec(text) ??
      /(?:^|\n)[! ]*One-time code \(([A-Z0-9]{4}-[A-Z0-9]{4})\) copied to clipboard(?:\s|$)/u.exec(
        text,
      );
    if (!match?.[1]) return;
    session.state = { ...session.state, phase: "waiting", code: match[1] };
    try {
      await this.effects.copy(match[1]);
      session.state.copied = true;
    } catch {
      /* Fallback button remains. */
    }
    if (!this.active(id)) return;
    try {
      await this.effects.open();
      session.state.opened = true;
    } catch {
      /* Fallback button remains. */
    }
  }
  private async clear(code?: string): Promise<void> {
    if (!code) return;
    try {
      if ((await this.effects.clipboard()) === code) await this.effects.clear();
    } catch {
      /* Clipboard unavailable. */
    }
  }
  async finish(id: string, code: number): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.active = false;
    session.off?.();
    await Promise.allSettled([session.pending, ...session.actions.values()]);
    await this.clear(session.state.code);
    const expired =
      !session.cancelled &&
      code !== 0 &&
      (await this.effects.screen(id).then(
        ({ lines }) =>
          lines.some((line) => /(?:device|one-time) code (?:has )?expired/iu.test(line)),
        () => false,
      ));
    session.state = {
      ...session.state,
      code: undefined,
      phase: session.cancelled ? "cancelled" : code === 0 ? "done" : expired ? "expired" : "failed",
      exitCode: code,
    };
  }
  async action(id: unknown, action: unknown): Promise<GithubSignInState> {
    if (
      typeof id !== "string" ||
      (action !== "read" && action !== "copy" && action !== "open" && action !== "cancel")
    )
      throw new Error("Sign-in unavailable");
    const session = this.sessions.get(id);
    if (!session) throw new Error("Sign-in unavailable");
    const command = action;
    if (command === "cancel" && session.active) {
      session.cancelled = true;
      try {
        await this.effects.stop(id);
      } catch (error) {
        session.cancelled = false;
        throw error;
      }
      await this.finish(id, -1);
    } else if (session.active && session.state.code && (command === "copy" || command === "open")) {
      const existing = session.actions.get(command);
      if (existing) {
        await existing;
        return { ...session.state };
      }
      const code = session.state.code;
      const work = (async () => {
        if (command === "copy") {
          try {
            await this.effects.copy(code);
            session.state.copied = true;
          } catch {
            session.state.copied = false;
          }
        } else {
          try {
            await this.effects.open();
            session.state.opened = true;
          } catch {
            session.state.opened = false;
          }
        }
      })();
      session.actions.set(command, work);
      try {
        await work;
      } finally {
        session.actions.delete(command);
      }
    }
    return { ...session.state };
  }
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.active = false;
      session.off?.();
      const code = session.state.code;
      void Promise.allSettled([session.pending, ...session.actions.values()]).then(() =>
        this.clear(code),
      );
    }
    this.sessions.clear();
  }
}
