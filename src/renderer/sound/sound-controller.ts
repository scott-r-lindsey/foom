import type { AudioSink, SoundSettings } from "../../shared/sound";
import { DEFAULT_SOUND } from "../../shared/sounds";
import type { BoardSource } from "../board/board-source";
import type { BoardRow } from "../board/board.d";
import type { SetupSource } from "../preflight/setup-source.d";

export const SETTLE_MS = 1000;
export const DEBOUNCE_MS = 2000;
export const REPEAT_MS = 120_000;

/** A logarithmic mix: ten busy terminals cannot become ten times as loud. */
export function activityIntensity(rates: readonly number[]): number {
  const total = rates.reduce(
    (sum, rate) => sum + (Number.isFinite(rate) && rate > 0 ? rate : 0),
    0,
  );
  return Math.min(1, Math.log1p(total) / Math.log1p(50_000));
}

/** No terminal text enters audio. Only state, IDs, rates and the visible terminal matter. */
export function createSoundController(
  source: BoardSource,
  setup: Pick<SetupSource, "state" | "subscribe">,
  sink: AudioSink,
  focused: () => string | undefined,
  now: () => number = Date.now,
) {
  let settings: SoundSettings = DEFAULT_SOUND;
  let disposed = false;
  let loaded = false;
  let settingsRevision = 0;
  let lastAlert = -Infinity;
  const rates = new Map<string, number>();
  const verdicts = new Map<string, { state: BoardRow["state"]; since: number; next: number }>();
  const updateRows = () => {
    const rows = source.getSnapshot();
    const ids = new Set(rows.map((row) => row.id));
    for (const id of verdicts.keys())
      if (!ids.has(id)) {
        verdicts.delete(id);
        rates.delete(id);
      }
    for (const row of rows) {
      const previous = verdicts.get(row.id);
      if (!previous || previous.state !== row.state)
        verdicts.set(row.id, { state: row.state, since: now(), next: now() + SETTLE_MS });
      if (row.exited) rates.set(row.id, 0);
      else if (!rates.has(row.id)) rates.set(row.id, row.rate);
    }
  };
  const apply = (next: SoundSettings) => {
    loaded = true;
    settings = next;
    sink.configure(settings.choices);
    if (!settings.alerts || settings.alertVolume === 0) sink.silenceAlerts();
    tick();
  };
  const tick = () => {
    if (!loaded) return;
    const time = now();
    sink.working(
      settings.working ? activityIntensity([...rates.values()]) : 0,
      settings.workingVolume,
    );
    const due = [...verdicts.entries()].filter(([id, verdict]) => {
      if (verdict.state !== "done" && verdict.state !== "needs_input") return false;
      if (id === focused() || !settings.alerts || settings.alertVolume === 0) {
        // Do not replay a completion later; attention can remind after leaving its view.
        verdict.next = verdict.state === "done" ? Infinity : time + REPEAT_MS;
        return false;
      }
      return time - verdict.since >= SETTLE_MS && time >= verdict.next;
    });
    if (!due.length || time - lastAlert < DEBOUNCE_MS) return;
    // One mixed alert for a burst. Attention wins when both kinds arrive together.
    sink.alert(
      due.some(([, entry]) => entry.state === "needs_input") ? "needs-you" : "done",
      settings.alertVolume,
    );
    lastAlert = time;
    for (const [, verdict] of due)
      verdict.next = verdict.state === "needs_input" ? time + REPEAT_MS : Infinity;
  };
  updateRows();
  const offRows = source.subscribe(updateRows);
  const offActivity = source.subscribeActivity((batch) => {
    for (const { id, rate } of batch) if (verdicts.has(id)) rates.set(id, rate);
  });
  const offSetup = setup.subscribe((state) => {
    settingsRevision++;
    apply(state.settings.sound);
  });
  const revision = settingsRevision;
  void setup.state().then(
    (state) => {
      if (!disposed && revision === settingsRevision) apply(state.settings.sound);
    },
    () => {
      if (!disposed && revision === settingsRevision) apply(DEFAULT_SOUND);
    },
  );
  const timer = setInterval(tick, 100);
  const dispose = () => {
    disposed = true;
    clearInterval(timer);
    offRows();
    offActivity();
    offSetup();
    sink.dispose();
  };
  dispose.refuse = () => {
    if (loaded && !disposed && settings.alerts) sink.alert("refusal", settings.alertVolume);
  };
  return dispose;
}
