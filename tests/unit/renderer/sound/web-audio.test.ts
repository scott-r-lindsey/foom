// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { createAudioSink } from "../../../../src/renderer/sound/web-audio";
import { DEFAULT_SOUND } from "../../../../src/shared/sounds";
import type { SoundRequest } from "../../../../src/shared/sound";
class Param {
  setValueAtTime = vi.fn();
  setTargetAtTime = vi.fn();
}
class Node {
  buffer: AudioBuffer | null = null;
  loop = false;
  gain = new Param();
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  onended?: () => void;
}
class Context {
  currentTime = 0;
  state = "suspended";
  destination = {};
  nodes: Node[] = [];
  gains: Node[] = [];
  createBufferSource() {
    const node = new Node();
    this.nodes.push(node);
    return node;
  }
  createGain() {
    const node = new Node();
    this.gains.push(node);
    return node;
  }
  decodeAudioData = vi.fn((_data: ArrayBuffer) =>
    Promise.resolve({
      duration: 0.2,
      numberOfChannels: 1,
      length: 2,
      sampleRate: 48000,
      copyFromChannel: vi.fn(),
      copyToChannel: vi.fn(),
      getChannelData: () => new Float32Array([0.1, -0.1]),
    } satisfies AudioBuffer),
  );
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function fixture() {
  const ctx = new Context();
  let refresh = () => {};
  const off = vi.fn();
  const api = {
    read: vi.fn((request: SoundRequest) =>
      Promise.resolve({
        bytes: new Uint8Array([request.kind === "working" ? 1 : 0]),
      }),
    ),
    onChange: (cb: () => void) => {
      refresh = cb;
      return off;
    },
  };
  ctx.decodeAudioData.mockImplementation((data: ArrayBuffer) =>
    Promise.resolve({
      duration: new Uint8Array(data)[0] === 1 ? 2 : 0.2,
      numberOfChannels: 1,
      length: 2,
      sampleRate: 48000,
      copyFromChannel: vi.fn(),
      copyToChannel: vi.fn(),
      getChannelData: () => new Float32Array([0.1, -0.1]),
    } satisfies AudioBuffer),
  );
  const report = vi.fn();
  const create = vi.fn(() => ctx as unknown as AudioContext);
  const sink = createAudioSink(create, api, report);
  return {
    ctx,
    sink,
    api,
    create,
    report,
    off,
    refresh: () => {
      refresh();
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
test("loads selected recordings, keeps one loop, ramps activity and independently plays refusal", async () => {
  const f = fixture();
  f.sink.working(0, 1);
  expect(f.create).not.toHaveBeenCalled();
  f.sink.configure(DEFAULT_SOUND.choices);
  f.sink.working(0.7, 0.2);
  await flush();
  expect(f.ctx.nodes).toHaveLength(1);
  expect(f.ctx.nodes[0]?.loop).toBe(true);
  f.ctx.state = "running";
  f.sink.working(0.2, 0.4);
  expect(f.ctx.nodes).toHaveLength(1);
  f.sink.alert("done", 0.5);
  await flush();
  f.sink.alert("refusal", 0.5);
  await flush();
  expect(f.ctx.nodes).toHaveLength(3);
  expect(f.ctx.nodes[1]?.stop).not.toHaveBeenCalled();
  f.sink.alert("needs-you", 0.5);
  await flush();
  expect(f.ctx.nodes[1]?.stop).toHaveBeenCalled();
  f.sink.alert("refusal", 0.5);
  await flush();
  expect(f.ctx.nodes[2]?.stop).toHaveBeenCalled();
  f.ctx.nodes[4]?.onended?.();
  f.sink.configure(DEFAULT_SOUND.choices);
  expect(f.api.read).toHaveBeenCalledTimes(4);
  f.sink.working(0, 1);
  expect(f.ctx.nodes[0]?.stop).toHaveBeenCalled();
  f.sink.alert("done", 0);
  f.sink.working(NaN, Infinity);
  f.sink.silenceAlerts();
  f.sink.dispose();
  f.sink.dispose();
  expect(f.off).toHaveBeenCalledOnce();
  expect(f.ctx.close).toHaveBeenCalledOnce();
  f.sink.configure(DEFAULT_SOUND.choices);
  f.sink.alert("done", 1);
  f.sink.working(1, 1);
  await flush();
  expect(f.ctx.nodes).toHaveLength(5);
});
test("refreshes restored files and cancels pending old choices and muted or disposed alerts", async () => {
  const f = fixture();
  f.sink.configure(DEFAULT_SOUND.choices);
  f.sink.alert("done", 1);
  f.sink.silenceAlerts();
  await flush();
  expect(f.ctx.nodes).toHaveLength(0);
  f.sink.alert("done", 1);
  f.sink.configure({ ...DEFAULT_SOUND.choices, done: { source: "user", file: "new.wav" } });
  await flush();
  expect(f.ctx.nodes).toHaveLength(0);
  f.refresh();
  await flush();
  expect(f.api.read).toHaveBeenCalledTimes(12);
  f.sink.configure({ ...DEFAULT_SOUND.choices, refusal: { source: "user", file: "other.wav" } });
  f.sink.alert("refusal", 1);
  f.sink.dispose();
  await flush();
  expect(f.ctx.nodes).toHaveLength(0);
});
test("reports fallback and unavailable audio without disturbing terminal code", async () => {
  const f = fixture();
  f.api.read.mockRejectedValueOnce(new Error("missing"));
  f.sink.configure({ ...DEFAULT_SOUND.choices, working: { source: "user", file: "gone.ogg" } });
  await flush();
  expect(f.report).toHaveBeenCalledWith("working", expect.stringContaining("Using the default"));
  f.ctx.resume.mockRejectedValue(new Error("blocked"));
  f.ctx.close.mockRejectedValue(new Error("closed"));
  f.sink.alert("done", 1);
  await flush();
  f.sink.dispose();
  await flush();
  const unavailable = fixture();
  unavailable.create.mockImplementation(() => {
    throw Error("device");
  });
  unavailable.sink.configure(DEFAULT_SOUND.choices);
  expect(unavailable.report).toHaveBeenCalledTimes(4);
  unavailable.sink.dispose();
  const bad = fixture();
  bad.ctx.decodeAudioData.mockRejectedValue(new Error("codec"));
  bad.sink.configure(DEFAULT_SOUND.choices);
  await flush();
  expect(bad.report).toHaveBeenCalledWith("done", expect.stringContaining("default could not"));
  bad.sink.dispose();
});
test("default bridge and context work, and node creation failures remain silent", async () => {
  const f = fixture();
  vi.stubGlobal("AudioContext", function () {
    return f.ctx;
  });
  Object.defineProperty(window, "desktop", { value: { sounds: f.api }, configurable: true });
  const sink = createAudioSink();
  sink.configure(DEFAULT_SOUND.choices);
  await flush();
  vi.spyOn(f.ctx, "createBufferSource").mockImplementation(() => {
    throw Error("device lost");
  });
  sink.alert("done", 1);
  await flush();
  sink.dispose();
  f.sink.dispose();
});
