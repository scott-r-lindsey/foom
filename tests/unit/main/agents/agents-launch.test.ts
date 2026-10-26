import {
  binding,
  cleanup,
  create,
  launchIdentity,
  listWorktrees,
  prepare,
  request,
  root,
  agentFixture,
  tree,
} from "./agents-fixture";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentService } from "../../../../src/main/agents/agents";
import type { TerminalSpec } from "../../../../src/shared/desktop";

describe("automation spawn authority", () => {
  it("rechecks main-owned authority immediately before spawning and cleans up a refused launch", async () => {
    const beforeSpawn = vi.fn(() => {
      throw new Error("Automation stopped");
    });
    await agentFixture.service.scan();
    await expect(agentFixture.service.launch({ ...request, beforeSpawn })).rejects.toThrow(
      "Automation stopped",
    );
    expect(beforeSpawn).toHaveBeenCalledOnce();
  });
});

describe("launch", () => {
  it("launches Claude through the manager with invocation-only settings and resolved PATH", async () => {
    await agentFixture.service.launch(request);
    const spec = create.mock.calls[0];
    expect(spec).toEqual([
      expect.objectContaining({
        cwd: tree,
        cols: 80,
        rows: 24,
        env: { ...binding.env, PATH: root },
        args: [
          "--settings",
          JSON.stringify({
            hooks: {
              UserPromptSubmit: [
                { hooks: [{ type: "command", command: binding.observerCommand }] },
              ],
              PreToolUse: [{ hooks: [{ type: "command", command: binding.observerCommand }] }],
              Stop: [{ hooks: [{ type: "command", command: binding.observerCommand }] }],
              PermissionRequest: [
                { hooks: [{ type: "command", command: binding.observerCommand }] },
              ],
              Notification: [{ hooks: [{ type: "command", command: binding.observerCommand }] }],
            },
          }),
        ],
      }),
    ]);
    agentFixture.service.release("terminal-id");
    agentFixture.service.release("terminal-id");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it("tells the hook binding its terminal ID once the launch has one", async () => {
    const bind = vi.fn();
    prepare.mockResolvedValueOnce({ ...binding, bind });
    await agentFixture.service.launch(request);
    expect(bind).toHaveBeenCalledExactlyOnceWith("terminal-id");
  });
  it("attaches the Codex notifier on the first launch without consent", async () => {
    await agentFixture.service.launch({ ...request, agent: "codex" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["-c", `notify=${JSON.stringify(binding.observerArgv)}`] }),
    );
    agentFixture.service.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it("disables all attachment with the setting and never hooks Antigravity", async () => {
    agentFixture.service.setHooksEnabled(false);
    await agentFixture.service.launch({ ...request, agent: "codex" });
    agentFixture.service.release("terminal-id");
    agentFixture.service.setHooksEnabled(true);
    await agentFixture.service.launch({ ...request, agent: "agy" });
    expect(prepare).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ args: [], env: { PATH: root } }));
  });
  it("uses evaluation when a hook receiver is unavailable", async () => {
    agentFixture.service = new AgentService({ listWorktrees, launchIdentity }, { create });
    await expect(agentFixture.service.launch(request)).resolves.toMatchObject({
      id: "terminal-id",
      attention: "evaluator",
    });
  });
  it("revokes hooks if PTY creation fails", async () => {
    create.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });
    await expect(agentFixture.service.launch(request)).rejects.toThrow("spawn failed");
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it("awaits asynchronous terminal creation and cleans up rejected or cancelled launches", async () => {
    const asyncCreate = vi.fn<(_spec: TerminalSpec) => Promise<string>>();
    agentFixture.service = new AgentService(
      { listWorktrees, launchIdentity },
      { create: asyncCreate },
      prepare,
    );
    asyncCreate.mockRejectedValueOnce(new Error("host stopped"));
    await expect(agentFixture.service.launch(request)).rejects.toThrow("host stopped");
    expect(cleanup).toHaveBeenCalledOnce();
    asyncCreate.mockResolvedValueOnce("host-terminal");
    await expect(agentFixture.service.launch(request)).resolves.toHaveProperty(
      "id",
      "host-terminal",
    );
    agentFixture.service.release("host-terminal");
    expect(cleanup).toHaveBeenCalledTimes(2);
    asyncCreate.mockImplementationOnce(() => {
      agentFixture.service.dispose();
      return Promise.resolve("late-terminal");
    });
    await expect(agentFixture.service.launch(request)).rejects.toThrow("disposed");
    expect(cleanup).toHaveBeenCalledTimes(3);
  });
  it("does not spawn if hook preparation fails", async () => {
    prepare.mockRejectedValueOnce(new Error("receiver failed"));
    await expect(agentFixture.service.launch(request)).rejects.toThrow("receiver failed");
    expect(create).not.toHaveBeenCalled();
  });
  it("reserves worktrees during concurrent launches and frees them on exit", async () => {
    const first = agentFixture.service.launch(request);
    await expect(agentFixture.service.launch(request)).rejects.toThrow("already running");
    await first;
    agentFixture.service.release("terminal-id");
    await expect(agentFixture.service.launch(request)).resolves.toHaveProperty("id", "terminal-id");
  });
  it("uses inherited PATH on Windows and discovers native executables", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const scan = await agentFixture.service.scan();
    expect(scan.warning).toBeNull();
    expect(scan.agents[0]?.path).toBe(join(root, "claude.exe"));
    expect(execFile).not.toHaveBeenCalledWith(
      "/bin/zsh",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
  it("cancels in-flight launches and revokes prepared hooks on shutdown", async () => {
    prepare.mockImplementationOnce(() => {
      agentFixture.service.dispose();
      return Promise.resolve(binding);
    });
    await expect(agentFixture.service.launch(request)).rejects.toThrow("disposed");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    await expect(agentFixture.service.launch(request)).rejects.toThrow("disposed");
  });
  it("rejects invalid dimensions, unknown agents, and unavailable paths", async () => {
    for (const cols of [0, 501, 1.5, Number.NaN])
      await expect(agentFixture.service.launch({ ...request, cols })).rejects.toThrow("dimensions");
    const invalid = { ...request };
    Reflect.set(invalid, "agent", "unknown");
    await expect(agentFixture.service.launch(invalid)).rejects.toThrow("Unknown agent");
    for (const worktree of ["relative", `${tree}\0`])
      await expect(agentFixture.service.launch({ ...request, worktree })).rejects.toThrow(
        "Invalid worktree",
      );
    for (const entries of [
      [],
      [{ path: tree, managed: false, locked: true }],
      [{ path: tree, managed: true, bare: true }],
      [{ path: tree, managed: true, prunable: true }],
    ]) {
      listWorktrees.mockResolvedValueOnce(entries);
      await expect(agentFixture.service.launch(request)).rejects.toThrow("missing");
    }
    expect(create).not.toHaveBeenCalled();
  });
});

it.each([
  "--no-alt-screen",
  "  --no-alt-screen\n",
  "--no-alt-screen-extra",
  "prefix--no-alt-screen",
  "--other",
])("Codex inline launch requires the complete help flag: %s", async (text) => {
  agentFixture.help = text;
  agentFixture.service.setHooksEnabled(false);
  await agentFixture.service.launch({ ...request, agent: "codex" });
  expect(create.mock.calls[0]?.[0].args).toEqual(
    text.trim() === "--no-alt-screen" ? ["--no-alt-screen"] : [],
  );
});

it("main-only checkout authorization permits the registered checkout and retains shared occupancy after release or failure", async () => {
  listWorktrees.mockResolvedValue([{ path: root, managed: false, bare: false, prunable: false }]);
  const main = { ...request, worktree: root, mainCheckout: true, sharedCheckout: true };
  create.mockReturnValueOnce("first").mockReturnValueOnce("second");
  await agentFixture.service.launch(main);
  await agentFixture.service.launch(main);
  agentFixture.service.release("first");
  await expect(agentFixture.service.launch({ ...main, sharedCheckout: false })).rejects.toThrow(
    "already running",
  );
  create.mockImplementationOnce(() => {
    throw Error("spawn");
  });
  await expect(agentFixture.service.launch(main)).rejects.toThrow("spawn");
  await expect(agentFixture.service.launch({ ...main, sharedCheckout: false })).rejects.toThrow(
    "already running",
  );
  agentFixture.service.release("second");
  await agentFixture.service.launch({ ...main, sharedCheckout: false });
  agentFixture.service.release("terminal-id");
  await agentFixture.service.launch({ ...main, mainCheckout: false });
});

it("launches a main-authorized external checkout at its selected directory", async () => {
  listWorktrees.mockResolvedValue([{ path: tree, managed: false, bare: false, prunable: false }]);
  await agentFixture.service.launch({ ...request, checkoutIdentity: "identity" });
  expect(launchIdentity).toHaveBeenCalledWith(root, tree);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ cwd: tree }));
});

it.each(["replaced", "locked"])(
  "revalidates external checkout identity after hook preparation (%s)",
  async (reason) => {
    listWorktrees.mockResolvedValue([{ path: tree, managed: false, bare: false, prunable: false }]);
    if (reason === "replaced") launchIdentity.mockResolvedValueOnce("replacement");
    else launchIdentity.mockRejectedValueOnce(new Error("Worktree is locked"));
    await expect(
      agentFixture.service.launch({ ...request, checkoutIdentity: "identity" }),
    ).rejects.toThrow(reason === "replaced" ? "has changed" : "locked");
    expect(create).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    await agentFixture.service.launch({ ...request, checkoutIdentity: "identity" });
    expect(create).toHaveBeenCalledOnce();
  },
);

it("prepends literal defaults to Foom's inline and hook flags", async () => {
  agentFixture.help += "\n--no-alt-screen";
  const defaults = ["--model", "model with spaces", "-c", "model_reasoning_effort=high"];
  await agentFixture.service.launch({
    ...request,
    agent: "codex",
    defaultArguments: defaults,
  });
  expect(create.mock.calls[0]?.[0].args).toEqual([
    ...defaults,
    "--no-alt-screen",
    "-c",
    `notify=${JSON.stringify(binding.observerArgv)}`,
  ]);
});

it("keeps empty defaults identical to existing launches and validates main-only arguments", async () => {
  await agentFixture.service.launch({ ...request, defaultArguments: [] });
  const original = create.mock.calls[0]?.[0].args;
  agentFixture.service.release("terminal-id");
  await agentFixture.service.launch(request);
  expect(create.mock.calls[1]?.[0].args).toEqual(original);
  agentFixture.service.release("terminal-id");
  await expect(
    agentFixture.service.launch({ ...request, defaultArguments: ["--settings={}"] }),
  ).rejects.toThrow("reserved");
  expect(create).toHaveBeenCalledTimes(2);
});

it("passes defaults unchanged without hooks", async () => {
  agentFixture.service.setHooksEnabled(false);
  const defaults = ["--mode", "plan", "literal ; $(nothing) with spaces"];
  await agentFixture.service.launch({ ...request, agent: "agy", defaultArguments: defaults });
  expect(create.mock.calls[0]?.[0].args).toEqual(defaults);
});

it("launches an external checkout without a creation record", async () => {
  listWorktrees.mockResolvedValue([{ path: tree, managed: false, bare: false, prunable: false }]);
  await agentFixture.service.launch(request);
  expect(launchIdentity).toHaveBeenCalledWith(root, tree);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ cwd: tree }));
});

describe("per-child selections", () => {
  it("refuses invalid values before discovery or terminal creation", async () => {
    await expect(
      agentFixture.service.launch({ ...request, selection: { model: "--bad" } }),
    ).rejects.toThrow("invalid_request");
    expect(execFile).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it.each([
    ["--model", "old", "--dangerously-skip-permissions"],
    ["--model", "--dangerously-skip-permissions"],
  ])("keeps bypass refusal on the final expanded argv %j", async (...defaults) => {
    await expect(
      agentFixture.service.launch({
        ...request,
        control: { parentId: "parent" },
        defaultArguments: defaults,
        selection: { model: "new", effort: "high" },
      }),
    ).rejects.toThrow("Unattended child bypass is unavailable");
    expect(create).not.toHaveBeenCalled();
  });
  it("replaces defaults and preserves unrelated arguments", async () => {
    await agentFixture.service.launch({
      ...request,
      defaultArguments: ["--model=old", "--verbose"],
      selection: { model: "new", effort: "low" },
    });
    expect(create.mock.calls[0]?.[0].args.slice(0, 5)).toEqual([
      "--verbose",
      "--model",
      "new",
      "--effort",
      "low",
    ]);
  });
});
