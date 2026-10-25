import { mkdtemp, writeFile, rm, access, symlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type * as Os from "node:os";
import {
  probeEnvironment,
  isolatedGitEnvironment,
  scratchRepository,
  probeProvider,
  prepareProbe,
} from "../../../../src/main/agents/probe-launch";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
import fixture from "../../../fixtures/agent-plugins-v2/copilot.json";
import { git } from "../../../helpers/git.js";
vi.mock("node:os", async (original) => {
  const os = await original<typeof Os>();
  return { ...os, userInfo: vi.fn(os.userInfo) };
});
let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "foom-probe-launch-"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
test("scrubs the complete login environment and refuses malformed shell output", async () => {
  vi.mocked(userInfo).mockReturnValue({ ...userInfo(), shell: join(root, "shell") });
  const run = vi.fn(() =>
    Promise.resolve({
      stdout:
        "chatter\0FOOM_PROBE_ENV\0PATH=/fixture\0OK=a=b\0FOOM_CONTROL_TOKEN=secret\0FOOM_CONFIG_TOKEN=secret\0GIT_WORK_TREE=/foreign\0CLAUDECODE=1\0ELECTRON_RUN_AS_NODE=1\0bad key=x\0",
    }),
  );
  expect(await probeEnvironment(run, "linux")).toEqual({ PATH: "/fixture", OK: "a=b" });
  expect(run.mock.calls).toHaveLength(1);
  const empty = vi.fn(() => Promise.resolve({ stdout: "PATH=/unmarked" }));
  await expect(probeEnvironment(empty, "darwin")).rejects.toThrow("environment unavailable");
  vi.mocked(userInfo).mockReturnValue({ ...userInfo(), shell: "relative" });
  await expect(probeEnvironment(run, "linux")).rejects.toThrow("shell unavailable");
  expect(
    await probeEnvironment(run, "win32", {
      Path: "C:\\fixture",
      GIT_DIR: "foreign",
      "ProgramFiles(x86)": "value",
      FOOM_CONTROL_TOKEN: "secret",
      OK: "value",
    }),
  ).toEqual({ Path: "C:\\fixture", OK: "value" });
});
test("initializes scratch git with no inherited Git or global template influence", async () => {
  const template = join(root, "global-config");
  await writeFile(template, "[init]\n templateDir = /missing/hostile-template\n");
  vi.stubEnv("GIT_CONFIG_GLOBAL", template);
  vi.stubEnv("GIT_DIR", join(root, "foreign.git"));
  const env = isolatedGitEnvironment(
    { GIT_DIR: "foreign", git_config_count: "2", PATH: "fixture" },
    false,
  );
  expect(env).toEqual({
    PATH: "fixture",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  });
  expect(isolatedGitEnvironment({}, true)["GIT_CONFIG_GLOBAL"]).toBe("NUL");
  const cwd = await scratchRepository();
  try {
    expect(
      await realpath((await git(["rev-parse", "--show-toplevel"], { cwd })).stdout.trim()),
    ).toBe(await realpath(cwd));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  vi.stubEnv("PATH", join(root, "missing"));
  await expect(scratchRepository()).rejects.toThrow();
});
test("captures only a strict v2 manifest with matching identity", async () => {
  const path = join(root, "draft.json");
  await writeFile(path, JSON.stringify(fixture));
  const provider = await probeProvider(
    { action: "start", agent: "copilot-fixture", manifest: "draft.json" },
    root,
  );
  expect(provider.id).toBe("copilot-fixture");
  expect(await probeProvider({ action: "start", agent: "claude" }, root)).toBe(
    agentProvider("claude"),
  );
  await expect(
    probeProvider({ action: "start", agent: "codex", manifest: path }, root),
  ).rejects.toThrow("mismatch");
  await writeFile(path, '{"version":1}');
  await expect(
    probeProvider({ action: "start", agent: "copilot-fixture", manifest: path }, root),
  ).rejects.toThrow();
  await expect(
    probeProvider({ action: "start", agent: "copilot-fixture", manifest: root }, root),
  ).rejects.toThrow("Unsafe manifest");
  if (process.platform !== "win32") {
    const link = join(root, "link.json");
    await symlink(path, link);
    await expect(
      probeProvider({ action: "start", agent: "copilot-fixture", manifest: link }, root),
    ).rejects.toThrow("Unsafe manifest");
  }
});
test.skipIf(process.platform === "win32")(
  "launches only a fixture with isolated hooks and MCP credentials and refuses bypass",
  async () => {
    const command = join(root, "copilot");
    await writeFile(
      command,
      '#!/bin/sh\ncase "$1" in\n--version) echo "0.0.1";;\n--help) echo "fixture";;\n*) exit 1;;\nesac\n',
      { mode: 0o700 },
    );
    const path = join(root, "draft.json");
    await writeFile(path, JSON.stringify(fixture));
    const provider = await probeProvider(
      { action: "start", agent: "copilot-fixture", manifest: path },
      root,
    );
    const metadataBypass = {
      ...provider,
      model: {
        ...provider.model,
        bypassEnvironment: [
          {
            name: "TERM_PROGRAM",
            match: "present-nonempty" as const,
            values: undefined,
            caseInsensitive: false,
            trim: false,
          },
        ],
      },
    };
    await expect(
      prepareProbe(metadataBypass, { action: "start", agent: "copilot-fixture" }, root, {
        PATH: root,
      }),
    ).rejects.toThrow("bypass environment refused");

    const prepared = await prepareProbe(
      provider,
      { action: "start", agent: "copilot-fixture" },
      root,
      {
        PATH: root,
      },
    );
    expect(prepared.agentVersion).toBe("0.0.1");
    expect(prepared.events?.()).toEqual({
      hooks: [],
      mcp: { connected: false, listedTools: false, pinged: false },
    });
    expect(prepared.spec).toMatchObject({
      cwd: root,
      replaceEnvironment: true,
      env: { PATH: root, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Foom" },
      command,
    });
    await prepared.dispose();
    await expect(
      prepareProbe(provider, { action: "start", agent: "copilot-fixture" }, root, {
        PATH: "relative",
      }),
    ).rejects.toThrow("executable unavailable");
    await expect(
      prepareProbe(provider, { action: "start", agent: "copilot-fixture" }, root, {
        PATH: root,
        ...Object.fromEntries(
          provider.model.bypassEnvironment.map((rule) => [rule.name, rule.values?.[0] ?? "1"]),
        ),
      }),
    ).rejects.toThrow("bypass environment refused");
    const bypass = {
      ...provider,
      model: {
        ...provider.model,
        launch: {
          ...provider.model.launch,
          arguments: { arguments: ["--allow-all-tools"], when: undefined },
        },
      },
    };
    await expect(
      prepareProbe(bypass, { action: "start", agent: "copilot-fixture" }, root, { PATH: root }),
    ).rejects.toThrow("bypass arguments refused");
    const environmentBypass = {
      ...provider,
      model: {
        ...provider.model,
        launch: {
          ...provider.model.launch,
          environment: [{ name: "COPILOT_ALLOW_ALL", value: "1", when: undefined }],
        },
        bypassEnvironment: [
          {
            name: "COPILOT_ALLOW_ALL",
            match: "present-nonempty" as const,
            values: undefined,
            caseInsensitive: false,
            trim: false,
          },
        ],
      },
    };
    await expect(
      prepareProbe(environmentBypass, { action: "start", agent: "copilot-fixture" }, root, {
        PATH: root,
      }),
    ).rejects.toThrow("bypass environment refused");
    await writeFile(command, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const final = await prepareProbe(
      provider,
      { action: "start", agent: "copilot-fixture", resume: "abc-123" },
      root,
      { PATH: root },
    );
    await final.dispose();
    await access(command);
  },
);
