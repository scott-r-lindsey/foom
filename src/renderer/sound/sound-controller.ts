import type { AudioSink, SoundSettings } from "../../shared/sound";
import { DEFAULT_SOUND } from "../../shared/sounds";
import type { BoardSource } from "../board/board-source";
import type { BoardRow } from "../board/board.d";
import type { SetupSource } from "../preflight/setup-source.d";

export const SETTLE_MS = 1000;
export const DEBOUNCE_MS = 2000;
export const REPEAT_MS = 120_000;

/** One steady voice for active agents. Terminal output never enters audio. */
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
  const working = new Set<string>();
  const consumed = new Map<string, string>();
  const verdicts = new Map<
    string,
    { state: BoardRow["state"]; since: number; next: number; key: string }
  >();
  const updateRows = () => {
    const rows = source.getSnapshot().filter((row) => row.kind !== "shell");
    const ids = new Set(rows.map((row) => row.id));
    for (const id of verdicts.keys())
      if (!ids.has(id)) {
        verdicts.delete(id);
        working.delete(id);
        consumed.delete(id);
      }
    for (const row of rows) {
      const previous = verdicts.get(row.id);
      const key = row.execution
        ? `${String(row.execution.launch)}:${String(row.execution.turn)}`
        : "";
      if (!previous || previous.state !== row.state || previous.key !== key) {
        const silent =
          row.kind === "agent" &&
          row.state === "done" &&
          (!previous ||
            row.execution?.phase !== "idle" ||
            row.execution.turn === 0 ||
            consumed.get(row.id) === key);
        if (silent) consumed.set(row.id, key);
        verdicts.set(row.id, {
          state: row.state,
          since: now(),
          next: silent ? Infinity : now() + SETTLE_MS,
          key,
        });
      }
      if (
        !row.exited &&
        ((row.kind === "agent" && row.execution?.phase === "working") ||
          (row.kind === "sample" && row.state === "working"))
      )
        working.add(row.id);
      else working.delete(row.id);
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
    sink.working(settings.working && working.size > 0 ? 1 : 0, settings.workingVolume);
    const due = [...verdicts.entries()].filter(([id, verdict]) => {
      if (verdict.state !== "done" && verdict.state !== "needs_input") return false;
      if (
        (verdict.state === "needs_input" && id === focused()) ||
        !settings.alerts ||
        settings.alertVolume === 0
      ) {
        // Do not replay a completion later; attention can remind after leaving its view.
        verdict.next = verdict.state === "done" ? Infinity : time + REPEAT_MS;
        if (verdict.state === "done") consumed.set(id, verdict.key);
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
    for (const [id, verdict] of due) {
      verdict.next = verdict.state === "needs_input" ? time + REPEAT_MS : Infinity;
      if (verdict.state === "done") consumed.set(id, verdict.key);
    }
  };
  updateRows();
  const offRows = source.subscribe(updateRows);
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
    offSetup();
    sink.dispose();
  };
  dispose.refuse = () => {
    if (loaded && !disposed && settings.alerts) sink.alert("refusal", settings.alertVolume);
  };
  return dispose;
}
