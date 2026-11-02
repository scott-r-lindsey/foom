import { mkdtemp, writeFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
const probe = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
vi.mock("../../../../src/terminal-host/remote/agent-discovery", () => ({ hostProbe: probe }));
import { buildFacts } from "../../../../src/terminal-host/remote/build-facts";
const roots: string[] = [];
afterEach(async () => {
  probe.mockReset();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(value?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "build-facts-"));
  roots.push(root);
  if (value !== undefined) await writeFile(join(root, "package.json"), JSON.stringify(value));
  return root;
}
test("declared Node and manager requirements use fixed version probes, without Corepack downloads", async () => {
  const root = await fixture({
    engines: { node: "^24.0.0 || >=26" },
    packageManager: "pnpm@10.34.7",
    scripts: { build: "bad" },
  });
  probe.mockResolvedValueOnce("v22.18.0\n").mockRejectedValueOnce(new Error("missing"));
  expect(await buildFacts(root, { PATH: "/fixture" })).toEqual([
    { tool: "node", required: "^24.0.0 || >=26", version: "22.18.0" },
    { tool: "pnpm", required: "10.34.7" },
  ]);
  expect(probe.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    ["node", ["--version"]],
    ["pnpm", ["--version"]],
  ]);
  expect(probe.mock.calls[0]?.[3]).toEqual({
    PATH: "/fixture",
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
  });
});
test.each([
  null,
  [],
  {},
  { engines: [] },
  { engines: { node: "$(bad)" }, packageManager: "evil@1.0" },
  { packageManager: 42 },
])("invalid declarations add no probes: %j", async (value) => {
  expect(await buildFacts(await fixture(value), {})).toEqual([]);
  expect(probe).not.toHaveBeenCalled();
});
test.each(["npm", "pnpm", "yarn", "bun"])(
  "declared %s is observed without running scripts",
  async (tool) => {
    probe.mockResolvedValue("1.2.3");
    expect(await buildFacts(await fixture({ packageManager: `${tool}@1.2.3` }), {})).toEqual([
      { tool, required: "1.2.3", version: "1.2.3" },
    ]);
  },
);
test("missing, malformed, oversized, symlink and directory manifests are ignored", async () => {
  const root = await fixture();
  const path = join(root, "package.json");
  expect(await buildFacts(root, {})).toEqual([]);
  await writeFile(path, "{");
  expect(await buildFacts(root, {})).toEqual([]);
  await writeFile(path, " ".repeat(65537));
  expect(await buildFacts(root, {})).toEqual([]);
  await rm(path);
  await mkdir(path);
  expect(await buildFacts(root, {})).toEqual([]);
  expect(probe).not.toHaveBeenCalled();
});
test("untrusted version output stays unknown and cancellation propagates", async () => {
  const root = await fixture({ engines: { node: ">=24" } });
  probe.mockResolvedValue("RAW OUTPUT\nsecret");
  expect(await buildFacts(root, {})).toEqual([{ tool: "node", required: ">=24" }]);
  const controller = new AbortController();
  probe.mockImplementation(() => {
    controller.abort();
    return Promise.reject(new Error("cancelled"));
  });
  await expect(buildFacts(root, {}, controller.signal)).rejects.toThrow();
});

test.skipIf(process.platform === "win32")("symlink manifests are never followed", async () => {
  const root = await fixture();
  await symlink(join(root, "outside"), join(root, "package.json"));
  expect(await buildFacts(root, {})).toEqual([]);
  expect(probe).not.toHaveBeenCalled();
});
