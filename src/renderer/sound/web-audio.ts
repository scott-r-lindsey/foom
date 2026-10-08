import type { AudioSink, SoundApi, SoundChoices, SoundKind } from "../../shared/sound";
import { SOUND_KINDS } from "../../shared/sounds";
import { loadRecording } from "./recording";
import type { Recording } from "./recording";
interface Voice {
  node: AudioBufferSourceNode;
  gain: GainNode;
  stop(): void;
}
/** One looping voice, one verdict voice and one independent refusal voice. */
export function createAudioSink(
  createContext: () => AudioContext = () => new AudioContext(),
  api: Pick<SoundApi, "read" | "onChange"> = window.desktop.sounds,
  report: (kind: SoundKind, reason?: string) => void = () => undefined,
): AudioSink {
  let context: AudioContext | undefined;
  let disposed = false;
  let configuration = "";
  let selections: SoundChoices | undefined;
  let revision = 0;
  let level = 0;
  let loop: Voice | undefined;
  let verdict: Voice | undefined;
  let refusal: Voice | undefined;
  let verdictGeneration = 0;
  let refusalGeneration = 0;
  let workingRecording: Recording | undefined;
  const recordings = new Map<SoundKind, Promise<Recording | undefined>>();
  const ready = () => {
    if (disposed) return undefined;
    try {
      context ??= createContext();
      return context;
    } catch {
      return undefined;
    }
  };
  const voice = (recording: Recording, volume: number, repeating: boolean): Voice | undefined => {
    const ctx = ready();
    if (!ctx) return undefined;
    try {
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      const node = ctx.createBufferSource();
      const gain = ctx.createGain();
      node.buffer = recording.buffer;
      node.loop = repeating;
      gain.gain.setValueAtTime(repeating ? 0 : volume * recording.gain, ctx.currentTime);
      if (repeating) gain.gain.setTargetAtTime(volume * recording.gain, ctx.currentTime, 0.05);
      node.connect(gain);
      gain.connect(ctx.destination);
      let stopped = false;
      const disconnect = () => {
        node.disconnect();
        gain.disconnect();
      };
      node.onended = disconnect;
      node.start();
      return {
        node,
        gain,
        stop() {
          if (!stopped) {
            stopped = true;
            node.stop();
            disconnect();
          }
        },
      };
    } catch {
      return undefined;
    }
  };
  const working = () => {
    if (!level || !workingRecording) {
      loop?.stop();
      loop = undefined;
      return;
    }
    if (!loop) loop = voice(workingRecording, level, true);
    else if (context)
      loop.gain.gain.setTargetAtTime(level * workingRecording.gain, context.currentTime, 0.05);
  };
  const silenceAlerts = () => {
    verdictGeneration++;
    refusalGeneration++;
    verdict?.stop();
    refusal?.stop();
    verdict = undefined;
    refusal = undefined;
  };
  const clamp = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
  const off = api.onChange(() => {
    configuration = "";
    if (selections) sink.configure(selections);
  });
  const sink: AudioSink = {
    configure(choices: SoundChoices) {
      const key = JSON.stringify(choices);
      if (disposed || key === configuration) return;
      selections = choices;
      configuration = key;
      const current = ++revision;
      silenceAlerts();
      loop?.stop();
      loop = undefined;
      workingRecording = undefined;
      recordings.clear();
      const ctx = ready();
      if (!ctx) {
        for (const kind of SOUND_KINDS) report(kind, "Audio device unavailable");
        return;
      }
      for (const kind of SOUND_KINDS) {
        const pending = loadRecording(
          kind,
          choices[kind],
          (request) => api.read(request),
          (data) => ctx.decodeAudioData(data),
        ).then(
          (recording) => {
            if (disposed || current !== revision) return undefined;
            report(kind, recording.reason);
            if (kind === "working") {
              workingRecording = recording;
              working();
            }
            return recording;
          },
          () => {
            if (!disposed && current === revision)
              report(kind, "Sound unavailable; the default could not be played");
            return undefined;
          },
        );
        recordings.set(kind, pending);
      }
    },
    working(intensity, volume) {
      if (!disposed) {
        level = clamp(intensity) * clamp(volume);
        working();
      }
    },
    alert(kind, volume) {
      if (disposed || clamp(volume) === 0) return;
      const independent = kind === "refusal";
      const generation = independent ? ++refusalGeneration : ++verdictGeneration;
      if (independent) {
        refusal?.stop();
        refusal = undefined;
      } else {
        verdict?.stop();
        verdict = undefined;
      }
      const current = revision;
      void recordings.get(kind)?.then((recording) => {
        if (
          !recording ||
          disposed ||
          current !== revision ||
          generation !== (independent ? refusalGeneration : verdictGeneration)
        )
          return;
        const next = voice(recording, clamp(volume), false);
        if (independent) refusal = next;
        else verdict = next;
      });
    },
    silenceAlerts,
    dispose() {
      if (disposed) return;
      off();
      disposed = true;
      revision++;
      silenceAlerts();
      loop?.stop();
      loop = undefined;
      recordings.clear();
      workingRecording = undefined;
      if (context) void context.close().catch(() => {});
      context = undefined;
    },
  };
  return sink;
}
