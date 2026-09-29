import { join } from "node:path";
import { Terminal } from "@xterm/headless";
import { expect, test, vi } from "vitest";
import { TerminalManager } from "../src/terminal-manager";
import { suppressTerminalReplies } from "../src/renderer/terminal-replies";

test.each(["detached", "attached", "detach", "reattach"])(
  "real PTY receives exactly one cursor reply (%s)",
  async (mode) => {
    const exited = vi.fn();
    const manager = new TerminalManager(exited);
    const view = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    suppressTerminalReplies(view);
    const id = manager.create({
      command: process.execPath,
      args: [join(import.meta.dirname, "../test/protocol-probe.js")],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    view.onData((data) => {
      manager.write(id, data);
    });
    const send = (token: string, data: string) => {
      view.write(data, () => {
        manager.acknowledge(id, token, data.length);
      });
    };
    try {
      if (mode !== "detached") await manager.attach(id, send);
      if (mode === "detach" || mode === "reattach") manager.detach(id);
      if (mode === "reattach") await manager.attach(id, send);
      await vi.waitFor(
        () => {
          expect(exited).toHaveBeenCalledWith(id, 0);
        },
        { timeout: 5000 },
      );
      expect((await manager.tail(id, 24)).join("\n")).toContain("PROTOCOL_OK");
    } finally {
      manager.dispose();
      view.dispose();
    }
  },
);

test("views suppress headless protocol replies while preserving display and user input", async () => {
  const view = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const replies = vi.fn();
  view.onData(replies);
  suppressTerminalReplies(view);
  try {
    for (const reset of [false, true]) {
      if (reset) view.reset();
      await new Promise<void>((resolve) => {
        view.write(
          "visible\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[?6n\x1b[4$p\x1b[?7$p\x1bP$qm\x1b\\",
          resolve,
        );
      });
      expect(replies).not.toHaveBeenCalled();
      expect(view.buffer.active.getLine(0)?.translateToString(true)).toBe("visible");
    }
    view.input("typed or pasted", true);
    expect(replies).toHaveBeenCalledWith("typed or pasted");
  } finally {
    view.dispose();
  }
});
