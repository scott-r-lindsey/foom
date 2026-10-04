import { afterEach, expect, test, vi } from "vitest";
import { createAudioSink } from "../../../../src/renderer/sound/web-audio";
import { SOUNDSCAPES } from "../../../../src/shared/soundscapes";
class Param {
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
  setTargetAtTime = vi.fn();
}
class Node {
  type = "sine";
  frequency = new Param();
  gain = new Param();
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  onended?: () => void;
}
class Context {
  static instances: Context[] = [];
  currentTime = 0;
  state = "suspended";
  destination = {};
  oscillators: Node[] = [];
  gains: Node[] = [];
  constructor() {
    Context.instances.push(this);
  }
  createOscillator() {
    const node = new Node();
    this.oscillators.push(node);
    return node;
  }
  createGain() {
    const node = new Node();
    this.gains.push(node);
    return node;
  }
  resume = vi.fn(() => Promise.resolve());
  close = vi.fn(() => Promise.resolve());
}
afterEach(() => {
  vi.unstubAllGlobals();
  Context.instances = [];
});
function fixture() {
  vi.stubGlobal("AudioContext", Context);
  const sink = createAudioSink();
  return {
    sink,
    context: () => {
      const ctx = Context.instances[0];
      if (!ctx) throw Error("No context");
      return ctx;
    },
  };
}
test("creates audio lazily, mixes one hum, schedules bounded seeks, stops on silence and closes", () => {
  const f = fixture();
  f.sink.working(0, 0.5, SOUNDSCAPES.drive);
  expect(Context.instances).toHaveLength(0);
  f.sink.working(1, 0.2, SOUNDSCAPES.drive);
  const ctx = f.context();
  expect(ctx.resume).toHaveBeenCalledOnce();
  expect(ctx.oscillators[0]?.type).toBe("triangle");
  expect(ctx.oscillators.length).toBeLessThanOrEqual(4);
  ctx.state = "running";
  ctx.currentTime = 0.1;
  f.sink.working(0.2, 0.4, SOUNDSCAPES.soft);
  expect(ctx.oscillators.filter((node) => node.type === "triangle")).toHaveLength(1);
  expect(ctx.oscillators[0]?.frequency.setTargetAtTime).toHaveBeenLastCalledWith(60, 0.1, 0.05);
  for (const node of ctx.oscillators.slice(1)) node.onended?.();
  f.sink.working(0, 0.4, SOUNDSCAPES.soft);
  expect(ctx.oscillators[0]?.stop).toHaveBeenCalled();
  f.sink.dispose();
  expect(ctx.close).toHaveBeenCalledOnce();
  f.sink.dispose();
});
test("uses distinct completion and attention cadence, replaces alerts and respects zero volume", () => {
  const f = fixture();
  f.sink.alert("done", 0, SOUNDSCAPES.drive);
  expect(Context.instances).toHaveLength(0);
  f.sink.alert("done", 0.5, SOUNDSCAPES.drive);
  const ctx = f.context();
  expect(ctx.oscillators).toHaveLength(1);
  expect(ctx.oscillators[0]?.frequency.setValueAtTime).toHaveBeenCalledWith(660, 0);
  f.sink.alert("needsYou", 0.5, SOUNDSCAPES.drive);
  expect(ctx.oscillators[0]?.disconnect).toHaveBeenCalled();
  expect(ctx.oscillators).toHaveLength(3);
  expect(ctx.oscillators[2]?.start).toHaveBeenCalledWith(0.13 + 0.16);
  f.sink.silenceAlerts();
  expect(ctx.oscillators[2]?.disconnect).toHaveBeenCalled();
  f.sink.dispose();
});
test("device construction, resume and close failures do not reach terminal code", async () => {
  vi.stubGlobal("AudioContext", function () {
    throw Error("No device");
  });
  const sink = createAudioSink();
  sink.alert("done", 1, SOUNDSCAPES.drive);
  sink.working(1, 1, SOUNDSCAPES.drive);
  sink.dispose();
  const f = fixture();
  f.sink.alert("done", 1, SOUNDSCAPES.drive);
  f.context().resume.mockRejectedValue(new Error("blocked"));
  f.context().close.mockRejectedValue(new Error("closed"));
  f.sink.working(1, 1, SOUNDSCAPES.drive);
  f.sink.dispose();
  await Promise.resolve();
});
