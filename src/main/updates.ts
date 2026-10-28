import { macUpdatePackage, nightlyUpdatePackage } from "./update-package";
import type { LocalUpdate, UpdatePackage } from "./update-package";
import type { UpdateState } from "../shared/updates";

export interface NativeUpdater {
  setFeedURL(options: { url: string; serverType: "json" }): void;
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
  activityFlags(): Promise<string>;
  prepareUpdate(update: UpdatePackage, signal: AbortSignal): Promise<LocalUpdate>;
  quit(): void;
  exit(): void;
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
  private local: LocalUpdate | undefined;
  private installing = false;
  private quitTimer: ReturnType<typeof setTimeout> | undefined;
  private exitTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly nightly: RegExpExecArray | null;
  private readonly native: boolean;
  private readonly listeners: ReadonlyArray<readonly [string, () => void]>;

  constructor(private readonly deps: UpdateDependencies) {
    this.nightly = NIGHTLY.exec(deps.version);
    this.native =
      deps.platform === "darwin" && (STABLE.test(deps.version) || this.nightly !== null);
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
          if (this.installing) this.fallbackQuit();
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
      this.releaseLocal();
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
    if (status !== "checking") this.releaseLocal();
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
      const request = new AbortController();
      this.request = request;
      const fallback = this.nightly
        ? `https://foom-term.com/updates/nightly/${this.deps.platform}-${this.deps.arch}/${this.native ? "latest-mac.json" : "latest.json"}`
        : this.native
          ? `https://update.electronjs.org/scott-r-lindsey/foom/darwin-${this.deps.arch}/${this.deps.version}`
          : `${API}latest`;
      let release: unknown;
      try {
        // Counting is optional: failed durable reservation uses the direct
        // source, without sending any unreserved activity flags.
        const flags = await this.deps.activityFlags();
        if (!this.current(generation)) return;
        release = await this.deps.getRelease(
          `https://foom-term.com/u/v1/${this.nightly ? "nightly" : "stable"}/${this.deps.platform}/${this.deps.arch}/${encodeURIComponent(this.deps.version)}${flags}`,
          request.signal,
        );
      } catch {
        if (!this.current(generation)) return;
        release = await this.deps.getRelease(fallback, request.signal);
      }
      if (generation !== this.generation) return;
      if (release === null) {
        this.finish("idle");
        return;
      }
      if (this.nightly || this.native) {
        const update = this.nightly
          ? nightlyUpdatePackage(release, this.deps.platform, this.deps.arch)
          : macUpdatePackage(release, this.deps.arch);
        if (
          !(this.nightly
            ? this.newerNightly(update)
            : newerStable(update.version, this.deps.version))
        ) {
          this.finish("idle");
          return;
        }
        if (!this.native) {
          this.finish("available");
          return;
        }
        const local = await this.deps.prepareUpdate(update, request.signal);
        if (!this.current(generation)) {
          await local.dispose();
          return;
        }
        this.local = local;
        // No await between the final opt-out check and native invocation. Both
        // feed and ZIP are private local files; Squirrel has no outbound URL.
        this.deps.updater.setFeedURL({ url: local.url, serverType: "json" });
        if (!this.current(generation)) return;
        this.deps.updater.checkForUpdates();
        return;
      }
      if (
        !record(release) ||
        release["draft"] !== false ||
        typeof release["prerelease"] !== "boolean" ||
        typeof release["tag_name"] !== "string"
      )
        throw new Error("Invalid release");
      if (release["prerelease"]) throw new Error("Invalid stable release");
      this.finish(newerStable(release["tag_name"], this.deps.version) ? "available" : "idle");
    } catch {
      if (generation === this.generation) this.finish("error");
    } finally {
      if (generation === this.generation) this.request = undefined;
    }
  }

  private newerNightly(update: UpdatePackage): boolean {
    const next = NIGHTLY.exec(update.version);
    const current = this.nightly;
    if (!next || !current || !next[1] || !current[1]) return false;
    // Channel never changes, and a lower base version is never an update.
    if (newerStable(current[1], next[1])) return false;
    return (
      Number(next[2]) > Number(current[2]) ||
      (next[2] === current[2] &&
        next[3] !== current[3] &&
        typeof this.deps.nightlyDate === "string" &&
        Date.parse(update.commitDate ?? "") > Date.parse(this.deps.nightlyDate))
    );
  }

  private current(generation: number): boolean {
    return this.enabled && generation === this.generation;
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
    // Shutdown has completed. A native failure must never leave a headless app.
    this.installing = true;
    this.quitTimer = setTimeout(() => {
      this.fallbackQuit();
    }, 5000);
    this.quitTimer.unref();
    try {
      this.deps.updater.quitAndInstall();
    } catch {
      this.fallbackQuit();
    }
    return true;
  }

  private fallbackQuit(): void {
    if (this.exitTimer) return;
    if (this.quitTimer) clearTimeout(this.quitTimer);
    this.exitTimer = setTimeout(() => {
      this.deps.exit();
    }, 1000);
    this.exitTimer.unref();
    try {
      this.deps.quit();
    } catch {
      /* The exit watchdog remains armed. */
    }
  }

  private releaseLocal(): void {
    const local = this.local;
    this.local = undefined;
    void local?.dispose().catch(() => undefined);
  }

  dispose(): void {
    this.configure(false);
    this.releaseLocal();
    if (this.native)
      // Keep the error listener (and installation watchdog) after disposal so a
      // late native failure still exits safely and cannot be unhandled.
      for (const [event, listener] of this.listeners)
        if (event !== "error") this.deps.updater.removeListener(event, listener);
  }
}
