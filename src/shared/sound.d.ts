export type SoundKind = "working" | "done" | "needs-you" | "refusal";
export interface SoundChoice {
  source: "builtin" | "user";
  file: string;
}
export type SoundChoices = Record<SoundKind, SoundChoice>;
export interface SoundSettings {
  choices: SoundChoices;
  working: boolean;
  workingVolume: number;
  alerts: boolean;
  alertVolume: number;
}
export type AlertSound = Exclude<SoundKind, "working">;
export interface SoundRequest extends SoundChoice {
  kind: SoundKind;
}
export interface SoundEntry extends SoundRequest {
  name: string;
  error?: string;
}
export type SoundRead = { bytes: Uint8Array } | { error: string };
export interface SoundApi {
  onChange(callback: () => void): () => void;
  list(): Promise<SoundEntry[]>;
  read(request: SoundRequest): Promise<SoundRead>;
  openFolder(): Promise<void>;
  notices(): Promise<string>;
}
export interface AudioSink {
  configure(choices: SoundChoices): void;
  working(intensity: number, volume: number): void;
  alert(kind: AlertSound, volume: number): void;
  silenceAlerts(): void;
  dispose(): void;
}
