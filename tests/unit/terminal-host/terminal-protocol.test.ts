import { join } from "node:path";
import { Terminal } from "@xterm/headless";
import { expect, test, vi } from "vitest";
import { TerminalColors } from "../../../src/shared/terminal-colors";
import { TerminalManager } from "../../../src/terminal-host/terminal-manager";
import { suppressTerminalReplies } from "../../../src/renderer/terminal/terminal-replies";

test.each(["detached", "attached", "detach", "reattach"])(
  "real PTY receives exactly one cursor and color reply (%s)",
  async (mode) => {
    const exited = vi.fn();
    const manager = new TerminalManager(exited);
    const view = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    suppressTerminalReplies(view);
    new TerminalColors(view.parser, false, () => {});
    const id = manager.create({
      command: process.execPath,
      args: [join(import.meta.dirname, "../../electron/protocol-probe.js"), "colors"],
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

test.skipIf(process.platform === "win32")(
  "shutdown force-stops an already removed SIGHUP-ignoring PTY",
  async () => {
    const manager = new TerminalManager(() => {});
    const id = manager.create({
      command: process.execPath,
      args: [
        "-e",
        'process.on("SIGHUP", () => {}); console.log("READY", process.pid); setInterval(() => {}, 1000)',
      ],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    let pid: number | undefined;
    try {
      await vi.waitFor(async () => {
        const tail = (await manager.tail(id, 5)).join("\n");
        expect(tail).toContain("READY");
        pid = Number(/READY (\d+)/.exec(tail)?.[1]);
        expect(pid).toBeGreaterThan(0);
      });
      manager.kill(id);
      expect(manager.runningCount).toBe(0);
      expect(manager.hasPendingExits).toBe(true);
      expect(() => {
        manager.write(id, "stale");
      }).toThrow("Unknown terminal");
      await manager.shutdown();
      expect(manager.hasPendingExits).toBe(false);
      expect(() => process.kill(pid ?? 0, 0)).toThrow();
    } finally {
      // Failure-only cleanup; successful shutdown must prove exit before this point.
      if (manager.hasPendingExits && pid) process.kill(pid, "SIGKILL");
      await manager.waitForExit();
      manager.dispose();
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "Bash reports ready, silent commands, and failures without an attached view",
  async () => {
    const states = vi.fn();
    const manager = new TerminalManager(() => {}, { onShellState: states });
    const id = manager.create({
      command: "/bin/bash",
      args: ["-l"],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      shellIntegration: true,
    });
    try {
      await vi.waitFor(
        () => {
          expect(states).toHaveBeenLastCalledWith(id, { phase: "prompt", exitCode: 0 });
        },
        { timeout: 5000 },
      );
      states.mockClear();
      manager.write(id, "sleep 0.3\r");
      await vi.waitFor(() => {
        expect(states).toHaveBeenCalledWith(id, { phase: "running" });
      });
      await vi.waitFor(() => {
        expect(states).toHaveBeenLastCalledWith(id, { phase: "prompt", exitCode: 0 });
      });
      states.mockClear();
      manager.write(id, "false\r");
      await vi.waitFor(() => {
        expect(states).toHaveBeenLastCalledWith(id, { phase: "prompt", exitCode: 1 });
      });
      expect((await manager.tail(id, 24)).join("\n")).not.toContain("633;");
    } finally {
      await manager.shutdown();
    }
  },
);
