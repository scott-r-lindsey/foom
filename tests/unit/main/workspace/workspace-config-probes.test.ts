import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
import { Workspace } from "../../../../src/main/workspace/workspace";
import { configDep, deps } from "./workspace-fixture";

test("config credentials create visible transient probes and revoke them on owner exit", async () => {
  const { exchange } = await import("../../../../src/cli/client");
  const launch = await import("../../../../src/main/agents/probe-launch");
  const scratch = await mkdtemp(join(tmpdir(), "foom-workspace-probe-"));
  vi.spyOn(launch, "probeEnvironment").mockResolvedValue({ PATH: "fixture" });
  vi.spyOn(launch, "scratchRepository").mockResolvedValue(scratch);
  vi.spyOn(launch, "probeProvider").mockResolvedValue(agentProvider("claude"));
  vi.spyOn(launch, "prepareProbe").mockResolvedValue({
    spec: { command: "fixture", args: [], cwd: scratch, cols: 80, rows: 24 },
    dispose: vi.fn(),
    conversationId: "probe-conversation",
  });
  deps.config = { ...configDep(), probeNotice: vi.fn(() => Promise.resolve(true)) };
  deps.placeChild = vi.fn();
  const create = vi
    .spyOn(deps.terminals, "create")
    .mockResolvedValueOnce("owner")
    .mockResolvedValueOnce("probe-terminal");
  deps.terminals.screen = vi.fn(() =>
    Promise.resolve({ lines: ["Continue? (y/n)"], title: "probe" }),
  );
  const reply = vi.fn(() => Promise.resolve());
  deps.terminals.reply = reply;
  const save = vi.fn<(records: unknown) => Promise<void>>(() => Promise.resolve());
  deps.sessions = { load: () => Promise.resolve([]), save, flush: () => Promise.resolve() };
  const workspace = new Workspace(deps);
  try {
    await workspace.sidebarCommand({ kind: "config-launch", run: "shell" }, () =>
      Promise.resolve(false),
    );
    const env = create.mock.calls[0]?.[0].env;
    const token = env?.["FOOM_CONFIG_TOKEN"];
    const url = env?.["FOOM_CONFIG_URL"];
    if (!token || !url) throw Error("Missing config capability");
    const result = await exchange(url, { action: "start", agent: "claude" }, token);
    if (
      typeof result !== "object" ||
      result === null ||
      !("result" in result) ||
      typeof result.result !== "object" ||
      result.result === null ||
      !("probe" in result.result)
    )
      throw Error("Missing probe");
    const probe = result.result.probe;
    expect(workspace.snapshot().terminals.find((row) => row.probe)).toMatchObject({
      id: "probe-terminal",
      config: true,
      probeNote: true,
      probeOwner: "owner",
      conversationId: "probe-conversation",
    });
    expect(deps.placeChild).toHaveBeenCalledWith("probe-terminal", "owner");
    await exchange(url, { action: "send", probe, text: "yes" }, token);
    expect(reply).toHaveBeenCalledWith("probe-terminal", "yes\r");
    await exchange(url, { action: "screen", probe }, token);
    workspace.input("probe-terminal");
    vi.useFakeTimers();
    await workspace.quiet("probe-terminal");
    await workspace.evidence("probe-terminal", { title: "probe", progress: null });
    await vi.advanceTimersByTimeAsync(59999);
    expect(
      workspace.snapshot().terminals.find((row) => row.id === "owner")?.state?.reason,
    ).not.toBe("Probe waiting");
    await vi.advanceTimersByTimeAsync(1);
    expect(workspace.snapshot().terminals.find((row) => row.id === "owner")?.state).toMatchObject({
      reason: "Probe waiting",
      signal: "probe:waiting",
      state: "needs_input",
    });
    expect(workspace.snapshot().terminals.find((row) => row.probe)?.state?.state).not.toBe(
      "needs_input",
    );
    await workspace.feedback("owner", null, "ignored");
    expect(workspace.snapshot().terminals.find((row) => row.id === "owner")?.state?.reason).toBe(
      "Probe waiting",
    );
    await workspace.feedback("owner", null, "dismissed");
    expect(
      workspace.snapshot().terminals.find((row) => row.id === "owner")?.state?.reason,
    ).not.toBe("Probe waiting");
    await workspace.quiet("probe-terminal");
    await vi.advanceTimersByTimeAsync(60000);
    expect(
      workspace.snapshot().terminals.find((row) => row.id === "owner")?.state?.reason,
    ).not.toBe("Probe waiting");
    workspace.input("probe-terminal");
    await workspace.quiet("probe-terminal");
    await vi.advanceTimersByTimeAsync(60000);
    workspace.input("probe-terminal");
    expect(
      workspace.snapshot().terminals.find((row) => row.id === "owner")?.state?.reason,
    ).not.toBe("Probe waiting");
    vi.useRealTimers();
    await workspace.exited("owner", 0);
    await vi.waitFor(() => {
      expect(workspace.snapshot().terminals.some((row) => row.probe)).toBe(false);
    });
    expect(await exchange(url, { action: "screen", probe }, token)).toEqual({
      error: "unauthorized",
    });
    for (const [records] of save.mock.calls)
      expect(records).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ probe: true })]),
      );
  } finally {
    vi.useRealTimers();
    await workspace.dispose();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a probe revoked during its first-note write cannot resurrect a tile", async () => {
  const { exchange } = await import("../../../../src/cli/client");
  const launch = await import("../../../../src/main/agents/probe-launch");
  const scratch = await mkdtemp(join(tmpdir(), "foom-probe-note-race-"));
  vi.spyOn(launch, "probeEnvironment").mockResolvedValue({ PATH: "fixture" });
  vi.spyOn(launch, "scratchRepository").mockResolvedValue(scratch);
  vi.spyOn(launch, "probeProvider").mockResolvedValue(agentProvider("claude"));
  vi.spyOn(launch, "prepareProbe").mockResolvedValue({
    spec: { command: "fixture", args: [], cwd: scratch, cols: 80, rows: 24 },
    dispose: vi.fn(),
  });
  let finish: ((first: boolean) => void) | undefined;
  const notice = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  deps.config = { ...configDep(), probeNotice: notice };
  const create = vi
    .spyOn(deps.terminals, "create")
    .mockResolvedValueOnce("owner")
    .mockResolvedValueOnce("probe-terminal");
  const workspace = new Workspace(deps);
  try {
    await workspace.sidebarCommand({ kind: "config-launch", run: "shell" }, () =>
      Promise.resolve(false),
    );
    const env = create.mock.calls[0]?.[0].env;
    const token = env?.["FOOM_CONFIG_TOKEN"];
    const url = env?.["FOOM_CONFIG_URL"];
    if (!token || !url) throw Error("Missing config capability");
    const starting = exchange(url, { action: "start", agent: "claude" }, token);
    await vi.waitFor(() => {
      expect(notice).toHaveBeenCalledOnce();
    });
    await workspace.exited("owner", 0);
    await vi.waitFor(() => {
      expect(workspace.snapshot().terminals.some((row) => row.id === "probe-terminal")).toBe(false);
    });
    finish?.(true);
    expect(await starting).toEqual({ error: "not_found" });
    expect(workspace.snapshot().terminals.some((row) => row.probe)).toBe(false);
  } finally {
    finish?.(true);
    await workspace.dispose();
    await rm(scratch, { recursive: true, force: true });
  }
});
