import type { AlertSound, AudioSink, Soundscape } from "../../shared/sound";

/** A single bounded mixer. Context creation is lazy; a blocked device never affects terminals. */
export function createAudioSink(
  createContext: () => AudioContext = () => new AudioContext(),
): AudioSink {
  let context: AudioContext | undefined;
  let hum: OscillatorNode | undefined;
  let humGain: GainNode | undefined;
  let clickAt = 0;
  const alerts = new Set<OscillatorNode>();
  const seeks = new Set<OscillatorNode>();
  const ready = () => {
    try {
      context ??= createContext();
      if (context.state === "suspended") void context.resume().catch(() => {});
      return context;
    } catch {
      return undefined;
    }
  };
  const stop = (nodes: Set<OscillatorNode>) => {
    for (const node of nodes) {
      node.stop();
      node.disconnect();
    }
    nodes.clear();
  };
  const pulse = (
    ctx: AudioContext,
    nodes: Set<OscillatorNode>,
    frequency: number,
    start: number,
    duration: number,
    volume: number,
    type: OscillatorType,
  ) => {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    nodes.add(oscillator);
    oscillator.onended = () => {
      nodes.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(start);
    oscillator.stop(start + duration);
  };
  const silenceAlerts = () => {
    stop(alerts);
  };
  return {
    working(intensity, volume, scape) {
      const level = Math.max(0, Math.min(1, intensity)) * Math.max(0, Math.min(1, volume));
      if (level === 0) {
        hum?.stop();
        hum?.disconnect();
        humGain?.disconnect();
        hum = undefined;
        humGain = undefined;
        stop(seeks);
        return;
      }
      const ctx = ready();
      if (!ctx) return;
      if (!hum) {
        hum = ctx.createOscillator();
        humGain = ctx.createGain();
        hum.type = "triangle";
        hum.connect(humGain);
        humGain.connect(ctx.destination);
        humGain.gain.setValueAtTime(0, ctx.currentTime);
        hum.start();
      }
      hum.frequency.setTargetAtTime(scape.working.hum, ctx.currentTime, 0.05);
      humGain?.gain.setTargetAtTime(level * 0.035, ctx.currentTime, 0.05);
      // The 100 ms controller clock schedules at most three tiny seeks ahead.
      const spacing = 1 / (scape.working.density * intensity);
      clickAt = Math.max(clickAt, ctx.currentTime);
      while (clickAt < ctx.currentTime + 0.1) {
        pulse(
          ctx,
          seeks,
          scape.working.seek * (0.7 + Math.random() * 0.6),
          clickAt,
          0.012,
          level * 0.07,
          "square",
        );
        clickAt += spacing * (0.75 + Math.random() * 0.5);
      }
    },
    alert(kind: AlertSound, volume, scape: Soundscape) {
      silenceAlerts();
      if (volume <= 0) return;
      const ctx = ready();
      if (!ctx) return;
      const tone = scape[kind];
      for (let i = 0; i < tone.count; i++)
        pulse(
          ctx,
          alerts,
          tone.frequency,
          ctx.currentTime + i * (tone.duration + tone.gap),
          tone.duration,
          Math.min(1, volume) * 0.15,
          "sine",
        );
    },
    silenceAlerts,
    dispose() {
      silenceAlerts();
      stop(seeks);
      hum?.stop();
      hum?.disconnect();
      humGain?.disconnect();
      hum = undefined;
      humGain = undefined;
      if (context) void context.close().catch(() => {});
      context = undefined;
    },
  };
}
