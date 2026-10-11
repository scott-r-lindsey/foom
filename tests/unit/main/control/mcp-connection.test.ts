import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { ControlService, MCP_CONNECTION_DEADLINE_MS } from "../../../../src/main/control/service";
import { Operations } from "../../../../src/main/control/operations";
afterEach(() => vi.useRealTimers());
it.each(["agent", "orchestrator"] as const)(
  "tracks %s timeout, recovery and launch isolation",
  (role) => {
    vi.useFakeTimers();
    const changed = vi.fn();
    const service = new ControlService(
      new Operations(
        () => Promise.resolve(),
        () => undefined,
      ),
      undefined,
      undefined,
      changed,
    );
    const launch = service.prepare(tmpdir(), tmpdir(), role);
    launch.bind("terminal", true);
    const actor = service.authenticate(launch.env["FOOM_CONTROL_TOKEN"] ?? "");
    expect(changed).toHaveBeenLastCalledWith("terminal", "connecting");
    vi.advanceTimersByTime(MCP_CONNECTION_DEADLINE_MS - 1);
    expect(changed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(changed).toHaveBeenLastCalledWith("terminal", "not-connected");
    service.mcpConnected(actor);
    expect(changed).toHaveBeenLastCalledWith("terminal", "connected");
    service.mcpConnected(actor);
    expect(changed).toHaveBeenCalledTimes(3);
    launch.dispose();
    const replacement = service.prepare(tmpdir(), tmpdir(), role);
    replacement.bind("terminal", true);
    changed.mockClear();
    launch.dispose();
    expect(changed).not.toHaveBeenCalled();
    expect(() => {
      service.mcpConnected(actor);
    }).toThrow("unauthorized");
    replacement.dispose();
    changed.mockClear();
    vi.advanceTimersByTime(MCP_CONNECTION_DEADLINE_MS);
    expect(changed).not.toHaveBeenCalled();
    service.close();
  },
);
it("cancels the deadline on connection and shutdown and ignores unattached launches", () => {
  vi.useFakeTimers();
  const changed = vi.fn();
  const service = new ControlService(
    new Operations(
      () => Promise.resolve(),
      () => undefined,
    ),
    undefined,
    undefined,
    changed,
  );
  const plain = service.prepare(tmpdir(), tmpdir());
  plain.bind("plain");
  service.mcpConnected(service.authenticate(plain.env["FOOM_CONTROL_TOKEN"] ?? ""));
  expect(changed).not.toHaveBeenCalled();
  const launch = service.prepare(tmpdir(), tmpdir());
  launch.bind("connected", true);
  service.mcpConnected(service.authenticate(launch.env["FOOM_CONTROL_TOKEN"] ?? ""));
  changed.mockClear();
  vi.advanceTimersByTime(MCP_CONNECTION_DEADLINE_MS);
  expect(changed).not.toHaveBeenCalled();
  const pending = service.prepare(tmpdir(), tmpdir());
  pending.bind("pending", true);
  service.close();
  changed.mockClear();
  vi.advanceTimersByTime(MCP_CONNECTION_DEADLINE_MS);
  expect(changed).not.toHaveBeenCalled();
});
