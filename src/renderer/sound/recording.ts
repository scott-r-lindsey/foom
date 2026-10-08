import type { SoundChoice, SoundKind, SoundRead, SoundRequest } from "../../shared/sound";
import { DEFAULT_SOUND } from "../../shared/sounds";
export interface Recording {
  buffer: AudioBuffer;
  gain: number;
  reason?: string;
}
/** Peak-bounded RMS normalization. Silence never receives unbounded amplification. */
export function recordingGain(kind: SoundKind, buffer: AudioBuffer): number {
  const maximum = kind === "working" ? 30 : kind === "refusal" ? 0.3 : 1.5;
  if (
    !Number.isFinite(buffer.duration) ||
    buffer.duration <= 0 ||
    buffer.duration > maximum ||
    (kind === "working" && buffer.duration < 1)
  )
    throw new Error(
      `Sound duration must be ${kind === "working" ? "1–30" : `at most ${String(maximum)}`} seconds`,
    );
  let sum = 0;
  let peak = 0;
  let count = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    for (const sample of buffer.getChannelData(channel)) {
      if (!Number.isFinite(sample)) throw new Error("Sound contains invalid audio samples");
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
      count++;
    }
  }
  if (!count || !peak) return 0;
  return Math.min(4, 10 ** (-25 / 20) / Math.sqrt(sum / count), 0.5 / peak);
}
export async function loadRecording(
  kind: SoundKind,
  choice: SoundChoice,
  read: (request: SoundRequest) => Promise<SoundRead>,
  decode: (data: ArrayBuffer) => Promise<AudioBuffer>,
): Promise<Recording> {
  const load = async (selected: SoundChoice) => {
    const result = await read({ kind, ...selected });
    if ("error" in result) throw new Error(result.error);
    let buffer: AudioBuffer;
    try {
      buffer = await decode(new Uint8Array(result.bytes).buffer);
    } catch {
      throw new Error("Sound could not be decoded");
    }
    return { buffer, gain: recordingGain(kind, buffer) };
  };
  try {
    return await load(choice);
  } catch (error) {
    const defaultChoice = DEFAULT_SOUND.choices[kind];
    if (choice.source === defaultChoice.source && choice.file === defaultChoice.file) throw error;
    const fallback = await load(DEFAULT_SOUND.choices[kind]);
    return {
      ...fallback,
      reason: `${error instanceof Error ? error.message : "Sound unavailable"}. Using the default sound.`,
    };
  }
}
