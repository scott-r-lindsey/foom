// Rejected frame-coalescing prototype: node --test spikes/terminal-streaming/fidelity.mjs
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import serialization from "@xterm/addon-serialize";
import { createOutputWriter as eagerWriter } from "./output-writer.mts";
import { createOutputWriter as frameWriter } from "./output-writer-frame.mts";
const { Terminal } = headless;
const { SerializeAddon } = serialization;
let frames;
let nextFrame;
beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
});
afterEach(() => {
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
});
function frame() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
}
const write = (terminal, data) => new Promise((resolve) => terminal.write(data, resolve));

for (const [mode, createOutputWriter] of [
  ["eager", eagerWriter],
  ["frame", frameWriter],
]) {
  test(`${mode}: isolated echo and focused streaming bypass frames; mixed chunks retain order and token ACKs`, () => {
    const writes = [];
    const acks = [];
    let focused = true;
    const writer = createOutputWriter(
      (data, parsed) => writes.push({ data, parsed }),
      (...ack) => acks.push(ack),
      () => focused,
    );
    writer.write("a", "old", "echo");
    assert.equal(writes[0].data, "echo");
    assert.equal(acks.length, 0);
    writes[0].parsed();
    assert.deepEqual(acks, [["a", "old", 4]]);
    focused = false;
    const large = "界".repeat(65536);
    writer.write("a", "old", "small");
    writer.write("a", "old", large);
    writer.write("a", "new", "tail", true);
    assert.equal(writes.length, 1);
    frame();
    assert.equal(writes[1].data, `small${large}tail\x1b[?25l`);
    assert.equal(acks.length, 1);
    writes[1].parsed();
    assert.deepEqual(acks.slice(1), [
      ["a", "old", 65541],
      ["a", "new", 4],
    ]);
    writer.write("a", "new", "queued");
    focused = true;
    writer.write("a", "new", "typed");
    assert.equal(writes[2].data, "queuedtyped");
    assert.equal(writes.length, 3);
    writer.dispose();
    assert.equal(frames.size, 0);
  });

  test(`${mode}: view backpressure waits for parse ACKs above 262144 and resumes below 65536`, () => {
    const writes = [];
    let outstanding = 0;
    const writer = createOutputWriter(
      (data, parsed) => writes.push({ data, parsed }),
      (_id, _token, count) => {
        outstanding -= count;
      },
      () => false,
    );
    for (let i = 0; i < 9; i++) {
      const chunk = String(i).repeat(32768);
      outstanding += chunk.length;
      writer.write("pty", "token", chunk);
    }
    assert.equal(outstanding, 294912);
    assert.ok(outstanding > 262144);
    frame();
    if (mode === "frame") {
      assert.equal(writes.length, 1);
      assert.equal(writes[0].data.length, 294912);
      writes[0].parsed();
      assert.equal(outstanding, 0);
      writer.dispose();
      return;
    }
    assert.equal(writes.length, 2);
    assert.equal(
      writes[1].data,
      Array.from({ length: 8 }, (_, i) => String(i + 1).repeat(32768)).join(""),
    );
    writes[0].parsed();
    assert.ok(outstanding >= 65536);
    writes[1].parsed();
    assert.equal(outstanding, 0);
    writer.dispose();
  });

  test(`${mode}: flush drains before reset/resize; disposal cancels queued work without premature ACK`, () => {
    const writes = [];
    const acks = [];
    const writer = createOutputWriter(
      (data, parsed) => writes.push({ data, parsed }),
      (...args) => acks.push(args),
      () => false,
    );
    writer.write("a", "old", "first");
    writer.write("a", "old", "before-resize");
    assert.equal(writer.flush(), true);
    assert.equal(writer.flush(), false);
    assert.deepEqual(
      writes.map((item) => item.data),
      mode === "frame" ? ["firstbefore-resize"] : ["first", "before-resize"],
    );
    writer.write("a", "old", "disposed");
    writer.dispose();
    frame();
    assert.equal(writes.length, mode === "frame" ? 1 : 2);
    assert.equal(acks.length, 0);
    for (const item of writes) item.parsed();
    assert.deepEqual(
      acks,
      mode === "frame"
        ? [["a", "old", 18]]
        : [
            ["a", "old", 5],
            ["a", "old", 13],
          ],
    );
  });

  test(`${mode}: byte-identical scrollback, ANSI/Unicode, alternate screen and resize with mixed small/large chunks`, async () => {
    const expected = new Terminal({ cols: 40, rows: 8, scrollback: 10000, allowProposedApi: true });
    const actual = new Terminal({ cols: 40, rows: 8, scrollback: 10000, allowProposedApi: true });
    const expectedSerializer = new SerializeAddon();
    const actualSerializer = new SerializeAddon();
    expected.loadAddon(expectedSerializer);
    actual.loadAddon(actualSerializer);
    let received = 0;
    let acknowledged = 0;
    const writer = createOutputWriter(
      (data, parsed) => actual.write(data, parsed),
      (_id, _token, count) => {
        acknowledged += count;
      },
      () => false,
    );
    const chunks = [1, 65536, 7, 4095, 2, 32768];
    async function stream(data) {
      let offset = 0;
      for (let index = 0; offset < data.length; index++) {
        const chunk = data.slice(offset, offset + chunks[index % chunks.length]);
        offset += chunk.length;
        received += chunk.length;
        expected.write(chunk);
        writer.write("pty", "token", chunk);
        if (index % 3 === 0) frame();
      }
      writer.flush();
      await Promise.all([write(expected, ""), write(actual, "")]);
      assert.equal(acknowledged, received);
      assert.deepEqual(
        Buffer.from(actualSerializer.serialize()),
        Buffer.from(expectedSerializer.serialize()),
      );
    }
    try {
      await stream(
        "🚀\r\n" +
          Array.from({ length: 700 }, (_, i) => `${i}:\x1b[32m界 café e\u0301\x1b[0m\r\n`).join(""),
      );
      // Explicit parser barriers order resize between stream stages. Caller must
      // flush queued output before applying a grid change, as it must before reset.
      expected.resize(29, 11);
      actual.resize(29, 11);
      await stream("\x1b[?1049h\x1b[2J\x1b[H" + "\x1b[33mALT\x1b[0m\r\n".repeat(2500));
      expected.resize(54, 9);
      actual.resize(54, 9);
      await stream("\x1b[?1049l\r\nBACK\r\n" + "normal\r\n".repeat(500));
    } finally {
      writer.dispose();
      actual.dispose();
      expected.dispose();
    }
  });
}
