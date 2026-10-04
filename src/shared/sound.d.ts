export interface Tone {
  frequency: number;
  duration: number;
  gap: number;
  count: number;
}
/** Versioned, sample-free synthesis data, suitable for a user configuration file. */
export interface Soundscape {
  version: 1;
  name: string;
  working: { hum: number; seek: number; density: number };
  done: Tone;
  needsYou: Tone;
}
export interface SoundSettings {
  soundscape: "drive" | "soft" | Soundscape;
  working: boolean;
  workingVolume: number;
  alerts: boolean;
  alertVolume: number;
}
export type AlertSound = "done" | "needsYou";
export interface AudioSink {
  working(intensity: number, volume: number, scape: Soundscape): void;
  alert(kind: AlertSound, volume: number, scape: Soundscape): void;
  silenceAlerts(): void;
  dispose(): void;
}
