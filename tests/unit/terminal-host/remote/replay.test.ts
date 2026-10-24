import { createConnection, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { afterEach, expect, test, vi } from "vitest";
import type { RemoteRequest, RemoteResponse } from "../../../../src/shared/remote-host";
import {
  MAX_REMOTE_MESSAGE,
  RemoteFrames,
  RemoteMessages,
  remoteFrame,
  remoteResponse,
} from "../../../../src/shared/remote-host-protocol";

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node-pty", () => ({ spawn: mock.spawn }));
import { serveHost } from "../../../../src/terminal-host/remote/daemon";

let host: ReturnType<typeof serveHost> | undefined;
let root: string | undefined;
const sockets: Socket[] = [];
const build = "a".repeat(64);
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await host?.close();
  if (root) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function connect(path: string) {
  const socket = createConnection(path);
  sockets.push(socket);
  await once(socket, "connect");
  const frames = new RemoteFrames();
  const reassembly = new RemoteMessages();
  const messages: Exclude<RemoteResponse, { type: "fragment" }>[] = [];
  socket.on("data", (bytes: Buffer) => {
    frames.push(bytes, (wire) => {
      if (!remoteResponse(wire)) throw new Error("Invalid response");
      const message = reassembly.push(wire);
      if (message) messages.push(message);
    });
  });
  const send = (message: RemoteRequest) => socket.write(remoteFrame(message));
  const result = async (request: number) => {
    for (;;) {
      const message = messages.find((m) => m.type === "result" && m.request === request);
      if (message?.type === "result") return message;
      await once(socket, "data");
    }
  };
  send({ type: "hello", build });
  while (messages.length === 0) await once(socket, "data");
  send({ type: "open", id: "one", request: 1, cols: 400, rows: 24 });
  await result(1);
  return { socket, messages, send, result };
}

test.skipIf(process.platform === "win32")(
  "reattaches a real 400-column 10000-line ANSI screen above the message cap without losing visible rows",
  async () => {
    let output = (_data: string) => {};
    const exits = new Set<(event: { exitCode: number }) => void>();
    const pty = {
      write: vi.fn(),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      onData: (listener: typeof output) => {
        output = listener;
        return { dispose: () => {} };
      },
      onExit: (listener: (event: { exitCode: number }) => void) => {
        exits.add(listener);
        return { dispose: () => exits.delete(listener) };
      },
      kill: vi.fn(() => {
        for (const exited of exits) exited({ exitCode: 0 });
      }),
    };
    mock.spawn.mockReturnValue(pty);
    root = await realpath(await mkdtemp(join(tmpdir(), "remote-replay-")));
    host = serveHost(build, root);
    await once(host.server, "listening");
    const path = join(root, ".foom-host/host.sock");
    const first = await connect(path);
    const closed = once(first.socket, "close");
    first.socket.destroy();
    await closed;
    output(("\x1b[31mA\x1b[32mB".repeat(200) + "\r\n").repeat(10000));
    const next = await connect(path);
    next.send({ type: "screen", id: "one", request: 2 });
    const expected = await next.result(2);
    const serialization = vi.spyOn(SerializeAddon.prototype, "serialize");
    next.send({ type: "attach", id: "one", request: 3, view: "v" });
    await next.result(3);
    expect(
      serialization.mock.results.some(
        (result) =>
          result.type === "return" && JSON.stringify(result.value).length > MAX_REMOTE_MESSAGE,
      ),
    ).toBe(true);
    const replay = next.messages.find((m) => m.type === "data");
    if (replay?.type !== "data") throw new Error("Missing replay");
    expect(JSON.stringify(replay).length).toBeLessThanOrEqual(MAX_REMOTE_MESSAGE);
    const view = new Terminal({ cols: 400, rows: 24, scrollback: 10000, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => {
        view.write(replay.data, resolve);
      });
      expect(
        Array.from({ length: 24 }, (_, y) =>
          view.buffer.active.getLine(view.buffer.active.baseY + y)?.translateToString(true),
        ),
      ).toEqual(expected.lines);
      expect(view.buffer.normal.baseY).toBe(0);
      for (let y = 0; y < 23; y++) {
        const row = view.buffer.active.getLine(view.buffer.active.baseY + y);
        for (let x = 0; x < 400; x++) expect(row?.getCell(x)?.getFgColor()).toBe((x % 2) + 1);
      }
      next.send({
        type: "acknowledge",
        id: "one",
        request: 4,
        token: replay.token,
        count: replay.data.length,
      });
      await next.result(4);
      next.send({ type: "tail", id: "one", request: 5, lines: 10000 });
      expect((await next.result(5)).lines).toHaveLength(10000);
      expect(mock.spawn).toHaveBeenCalledOnce();
      expect(pty.kill).not.toHaveBeenCalled();
      expect(next.socket.destroyed).toBe(false);
    } finally {
      view.dispose();
    }
  },
);
