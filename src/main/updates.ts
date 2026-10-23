import type { UpdateState } from "../shared/updates";

export interface NativeUpdater {
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

export interface UpdateDependencies {
  packaged: boolean;
  version: string;
  platform: string;
  arch: string;
  nightlyDate?: unknown;
  updater: NativeUpdater;
  getRelease(url: string, signal: AbortSignal): Promise<unknown>;
  changed(): void;
  /** Enters the existing confirmation, session freeze and PTY shutdown path. */
  requestQuit(): Promise<void>;
}

const API = "https://api.github.com/repos/scott-r-lindsey/foom/releases/";
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
const NIGHTLY = /^(\d+\.\d+\.\d+)-nightly\.(\d{8})\+([a-f0-9]{7})$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compare numeric stable versions, never release titles or publication order. */
export function newerStable(candidate: string, current: string): boolean {
  const next = STABLE.exec(candidate.replace(/^v/, ""));
  const previous = STABLE.exec(current);
  if (!next || !previous) return false;
  for (let part = 1; part <= 3; part++) {
    const difference = Number(next[part]) - Number(previous[part]);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** One startup check and six-hour retries; no path can restart work on receipt of an update. */
export class Updates {
  private enabled = false;
  private status: UpdateState["status"] = "idle";
  private timer: ReturnType<typeof setInterval> | undefined;
  private request: AbortController | undefined;
  private generation = 0;
  private restart = false;
  private readonly nightly: RegExpExecArray | null;
  private readonly native: boolean;
  private readonly listeners: ReadonlyArray<readonly [string, () => void]>;

  constructor(private readonly deps: UpdateDependencies) {
    this.nightly = NIGHTLY.exec(deps.version);
    this.native = deps.platform === "darwin" && STABLE.test(deps.version);
    this.listeners = [
      [
        "update-not-available",
        () => {
          this.finish("idle");
        },
      ],
      [
        "update-downloaded",
        () => {
          this.finish("downloaded");
        },
      ],
      [
        "error",
        () => {
          this.finish("error");
        },
      ],
    ];
    // Electron's error event needs a listener even after opt-out during a download.
    if (this.native)
      for (const [event, listener] of this.listeners) deps.updater.on(event, listener);
  }

  state(runningAgents: number): UpdateState {
    return { status: this.status, runningAgents };
  }

  configure(enabled: boolean): void {
    enabled =
      enabled &&
      this.deps.packaged &&
      (this.native || this.nightly !== null || this.deps.platform === "linux");
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.request?.abort();
    this.request = undefined;
    if (!enabled) {
      this.status = "idle";
      this.restart = false;
      this.deps.changed();
      return;
    }
    this.timer = setInterval(
      () => {
        void this.check();
      },
      6 * 60 * 60 * 1000,
    );
    this.timer.unref();
    void this.check();
  }

  private finish(status: UpdateState["status"]): void {
    if (!this.enabled) return;
    this.status = status;
    this.deps.changed();
  }

  async check(): Promise<void> {
    if (
      !this.enabled ||
      this.status === "checking" ||
      this.status === "downloaded" ||
      this.status === "available"
    )
      return;
    const generation = this.generation;
    this.finish("checking");
    try {
      if (this.native) {
        this.deps.updater.setFeedURL({
          url: `https://update.electronjs.org/scott-r-lindsey/foom/darwin-${this.deps.arch}/${this.deps.version}`,
        });
        this.deps.updater.checkForUpdates();
        return;
      }
      const request = new AbortController();
      this.request = request;
      const release = await this.deps.getRelease(
        `${API}${this.nightly ? "tags/nightly" : "latest"}`,
        request.signal,
      );
      if (generation !== this.generation) return;
      if (release === null) {
        this.finish("idle");
        return;
      }
      if (
        !record(release) ||
        release["draft"] !== false ||
        typeof release["prerelease"] !== "boolean" ||
        typeof release["tag_name"] !== "string"
      )
        throw new Error("Invalid release");
      let available = false;
      if (this.nightly) {
        // Publisher commits metadata after immutable assets. The signed CI version is in the body.
        const body = release["body"];
        if (release["tag_name"] !== "nightly" || !release["prerelease"] || typeof body !== "string")
          throw new Error("Invalid nightly");
        const version = /^Version: (\S+)$/m.exec(body)?.[1];
        const next = version === undefined ? null : NIGHTLY.exec(version);
        if (!next) throw new Error("Invalid nightly version");
        available =
          Number(next[2]) > Number(this.nightly[2]) ||
          (next[2] === this.nightly[2] &&
            next[3] !== this.nightly[3] &&
            typeof this.deps.nightlyDate === "string" &&
            Date.parse(/^Commit date: (\S+)$/m.exec(body)?.[1] ?? "") >
              Date.parse(this.deps.nightlyDate));
      } else {
        if (release["prerelease"]) throw new Error("Invalid stable release");
        available = newerStable(release["tag_name"], this.deps.version);
      }
      this.finish(available ? "available" : "idle");
    } catch {
      if (generation === this.generation) this.finish("error");
    } finally {
      if (generation === this.generation) this.request = undefined;
    }
  }

  async restartToUpdate(): Promise<void> {
    if (!this.enabled || this.status !== "downloaded" || this.restart) return;
    this.restart = true;
    try {
      await this.deps.requestQuit();
    } finally {
      this.restart = false;
    }
  }

  /** Called only after successful normal quit preparation and PTY shutdown. */
  quitting(): boolean {
    if (!this.restart || !this.enabled || this.status !== "downloaded") return false;
    // An explicit human request reaches this only after session save and PTY shutdown.
    try {
      this.deps.updater.quitAndInstall();
      return true;
    } catch {
      this.finish("error");
      return false;
    }
  }

  dispose(): void {
    this.configure(false);
    if (this.native)
      // Native downloads cannot be cancelled. Keep the error listener quiet until
      // process exit so a late native failure cannot become an unhandled event.
      for (const [event, listener] of this.listeners)
        if (event !== "error") this.deps.updater.removeListener(event, listener);
  }
}
