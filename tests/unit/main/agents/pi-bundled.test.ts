import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import data from "../../../../src/shared/bundled-agents/pi.json";
import modelError from "../../../fixtures/agent-detection/pi-model-error.json";
import {
  agentProvider,
  replaceConfigProviders,
} from "../../../../src/main/agents/providers/registry";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import { builtinAgent } from "../../../../src/shared/providers/catalog";
import {
  hasBypassArgument,
  parseAgentArguments,
} from "../../../../src/main/agents/default-arguments";
import { restoreAuthority, restorePlan } from "../../../../src/main/workspace/session-restore";
import { SessionStore, readSessions } from "../../../../src/main/workspace/session-store";
import { detectAgent } from "../../../../src/main/evaluator/agent-rules";

const provider = agentProvider("pi");
const request = { agent: "pi", repository: "/repo", worktree: "/repo", cols: 80, rows: 24 };
const id = "12345678-1234-4567-8910-123456789abc";
const installation = () => provider.discover("/fixture/pi", "1.4.0", "--session --session-id");

it("registers locked Pi data and Settings metadata and falls back when extension loading is unavailable", () => {
  expect(provider.origin).toBe("bundled");
  expect(builtinAgent("pi")).toMatchObject({
    name: "Pi",
    mark: "PI",
    command: "pi",
    resume: ["--session"],
    restoreControl: true,
  });
  expect(installation()).toMatchObject({
    version: "1.4.0",
    hooks: false,
    mcp: false,
    restoreControl: false,
  });
  expect(provider.model.launch.extension?.api).toBe("pi-v1");
  expect(() => parseAgentManifest(JSON.stringify(data))).toThrow("reserved-id");
  expect(() => {
    replaceConfigProviders([provider]);
  }).toThrow("Reserved");
});

it("assigns a fresh UUID, resumes the recorded ID, and preserves literal defaults", async () => {
  const first = await provider.prepareLaunch(
    installation(),
    request,
    ["--model", "fixture"],
    undefined,
    false,
    true,
  );
  try {
    expect(first.conversationId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(first.args).toEqual(["--model", "fixture", "--session-id", first.conversationId]);
    expect(first.mcp).toBe(false);
    const resumed = await provider.prepareLaunch(
      installation(),
      { ...request, conversationId: id },
      ["--model", "literal $(text)"],
      undefined,
      false,
      true,
    );
    expect(resumed.args).toEqual(["--session", id, "--model", "literal $(text)"]);
    expect(resumed.conversationId).toBeUndefined();
    resumed.dispose();
    expect(provider.resume(id)).toEqual(["--session", id]);
    expect(() => provider.resume("../session")).toThrow("Invalid");
    expect(
      readSessions([
        {
          id: "terminal",
          ...request,
          branch: "work",
          conversationId: id,
          providerOrigin: "bundled",
        },
      ])[0]?.conversationId,
    ).toBe(id);
  } finally {
    first.dispose();
  }
});

it.each(["1.3.9", "1.4.0-beta.1", "invalid"])(
  "gates the prompt surface for %s",
  async (version) => {
    const found = provider.discover("/fixture/pi", version, "--session --session-id");
    await expect(
      provider.prepareLaunch(
        found,
        { ...request, prompt: "reply ready" },
        [],
        undefined,
        false,
        false,
      ),
    ).rejects.toThrow("cannot take an initial prompt");
  },
);

it("never attaches MCP even when a control binding is supplied", async () => {
  const launch = await provider.prepareLaunch(
    installation(),
    request,
    [],
    { env: { FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1" }, dispose: vi.fn() },
    false,
    false,
  );
  expect(launch.mcp).toBe(false);
  expect(launch.mcpArguments).toEqual([]);
  launch.dispose();
});

it.each([
  "--session",
  "--session=id",
  "--session-id",
  "--session-dir",
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--fork",
  "--no-session",
  "--print",
  "-p",
  "--mode=rpc",
  "--extension",
  "--extension=/tmp/evil",
  "-e/tmp/evil",
  "--no-extensions",
  "--no-mcp",
])("reserves conversation and noninteractive selectors %s", (flag) => {
  expect(() => parseAgentArguments("pi", [flag])).toThrow("reserved");
});

it.each(["--approve", "--approve=true", "-a", "-a=true"])(
  "discloses project trust bypass %s",
  (flag) => {
    expect(hasBypassArgument("pi", [flag])).toBe(true);
  },
);
it("does not label --no-approve as a bypass", () => {
  expect(hasBypassArgument("pi", ["--no-approve"])).toBe(false);
});

it("keeps unknown and incomplete screens neutral and gives Working precedence over editor dividers", () => {
  const evidence = { title: "π - temp", progress: null };
  expect(detectAgent("pi", evidence, ["ordinary text"])).toBeUndefined();
  expect(detectAgent("pi", evidence, ["Model Name: GPT-6.1 Sol"])).toBeUndefined();
  expect(
    detectAgent("pi", evidence, [
      "── ⠋ Working ─────",
      "────────────────",
      "temp",
      "0.5%/272k (auto)",
    ])?.state,
  ).toBe("working");
  expect(detectAgent("pi", evidence, ["────────────────", "temp", "0.5%/272k (auto)"])?.state).toBe(
    "idle",
  );
});

it("gates prompts on complete help tokens and passes initial text as one literal argument", async () => {
  const launch = await provider.prepareLaunch(
    installation(),
    { ...request, prompt: "reply $(literal)" },
    [],
    undefined,
    false,
    false,
  );
  expect(launch.args.slice(-2)).toEqual(["--", expect.stringContaining("reply $(literal)")]);
  launch.dispose();
  const found = provider.discover("/fixture/pi", "1.4.0", "--session-other --session-id-other");
  await expect(
    provider.prepareLaunch(
      found,
      { ...request, prompt: "reply ready" },
      [],
      undefined,
      false,
      false,
    ),
  ).rejects.toThrow("cannot take an initial prompt");
});

it("validates active-screen sampling without changing older manifest identities", () => {
  expect(provider.model.attention.sampleWhileActive).toBe(true);
  const { sampleWhileActive: enabled, ...attention } = data.attention;
  expect(enabled).toBe(true);
  expect(
    parseAgentManifest(JSON.stringify({ ...data, id: "pi-copy", attention })).model.attention
      .sampleWhileActive,
  ).toBeUndefined();
  expect(() =>
    parseAgentManifest(
      JSON.stringify({
        ...data,
        id: "pi-copy",
        attention: { ...attention, sampleWhileActive: "true" },
      }),
    ),
  ).toThrow();
});

it("current Working beats a historical model error and newly appended content excludes the old blocker", () => {
  const evidence = { title: "π - temp", progress: null };
  const working = [
    ...modelError.tail,
    "── ⠋ Working ─────",
    "────────────────",
    "temp",
    "0.5%/272k (auto)",
  ];
  expect(detectAgent("pi", evidence, working)?.state).toBe("working");
  expect(detectAgent("pi", evidence, [...modelError.tail, "new output"])?.id).not.toBe(
    "provider_model",
  );
});

it("loads mixed saved sessions while former config Pi stays dormant without restore authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foom-pi-migration-"));
  try {
    const base = { repository: "/repo", worktree: "/repo", branch: "main", running: true };
    const rows = [
      { ...base, id: "shell", agent: "shell" },
      {
        ...base,
        id: "former-pi",
        agent: "pi",
        providerOrigin: "config",
        conversationId: id,
        orchestrator: { identity: "identity", history: [] },
      },
      {
        ...base,
        id: "codex",
        agent: "codex",
        providerOrigin: "bundled",
        conversationId: "codex-saved",
      },
      {
        ...base,
        id: "bundled-pi",
        agent: "pi",
        providerOrigin: "bundled",
        conversationId: "bundled-pi-saved",
      },
    ];
    await writeFile(join(directory, "sessions.json"), JSON.stringify(rows));
    const store = new SessionStore(directory);
    const entries = await store.load();
    expect(entries).toEqual(readSessions(rows));
    expect(entries.map((entry) => entry.id)).toEqual(rows.map((row) => row.id));
    const former = entries.find((entry) => entry.id === "former-pi");
    if (!former) throw Error("Missing former Pi session");
    expect(former).toMatchObject({
      providerOrigin: "config",
      conversationId: id,
      dormant: true,
      exited: true,
    });
    expect(restorePlan(entries, true).map((entry) => entry.id)).toEqual([
      "shell",
      "codex",
      "bundled-pi",
    ]);
    expect(restoreAuthority(former, "identity", installation(), true)).toBe(false);
    // Migration must deny authority even if a future bundled version gains MCP.
    expect(
      restoreAuthority(
        former,
        "identity",
        { ...installation(), mcp: true, restoreControl: true },
        true,
      ),
    ).toBe(false);
    await store.save(entries);
    expect(await store.load()).toEqual(entries);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
