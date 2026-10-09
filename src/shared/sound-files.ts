import type { SoundKind } from "./sound";
export const SOUND_FILE_LIMIT = 100;
export function soundSizeLimit(kind: SoundKind): number {
  return (kind === "working" ? 8 : 2) * 1024 * 1024;
}
export function matchesSoundHeader(file: string, bytes: Uint8Array): boolean {
  const starts = (text: string, at = 0) =>
    new TextDecoder().decode(bytes.subarray(at, at + text.length)) === text;
  const contains = (text: string) => new TextDecoder().decode(bytes).includes(text);
  switch (file.slice(file.lastIndexOf(".")).toLowerCase()) {
    case ".wav":
      return starts("RIFF") && starts("WAVE", 8);
    case ".flac":
      return starts("fLaC");
    case ".ogg":
      return starts("OggS") && (contains("OpusHead") || contains("\x01vorbis"));
    case ".opus":
      return starts("OggS") && contains("OpusHead");
    case ".mp3":
      return (
        (starts("ID3") && [2, 3, 4].includes(bytes[3] ?? 0)) ||
        (bytes[0] === 0xff &&
          ((bytes[1] ?? 0) & 0xe6) === 0xe2 &&
          ((bytes[2] ?? 0) & 0xf0) !== 0xf0)
      );
    default:
      return false;
  }
}
export function validSoundDuration(kind: SoundKind, duration: number): boolean {
  return (
    Number.isFinite(duration) &&
    duration > 0 &&
    duration <= (kind === "working" ? 30 : kind === "refusal" ? 0.3 : 1.5) &&
    (kind !== "working" || duration >= 1)
  );
}
