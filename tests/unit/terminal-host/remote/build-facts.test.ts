import { mkdtemp, writeFile, rm, symlink, mkdir, realpath, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import type * as Discovery from "../../../../src/terminal-host/remote/agent-discovery";
import type { hostProbe as Probe } from "../../../../src/terminal-host/remote/agent-discovery";
import { afterEach, expect, test, vi } from "vitest";
const probe = vi.hoisted(() => vi.fn<typeof Probe>());
vi.mock("../../../../src/terminal-host/remote/agent-discovery", () => ({ hostProbe: probe }));
import { buildFacts } from "../../../../src/terminal-host/remote/build-facts";
const roots: string[] = [];
const fixtures = new Map<string, { home: string; bin: string }>();
async function observe(root: string, env: NodeJS.ProcessEnv = {}, signal?: AbortSignal) {
  const value = fixtures.get(root);
  if (!value) throw new Error("Missing fixture");
  return buildFacts(root, { PATH: value.bin, ...env }, value.home, signal);
}
afterEach(async () => {
  probe.mockReset();
  fixtures.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(value?: unknown) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "build-facts-")));
  roots.push(parent);
  const root = join(parent, "checkout");
  const home = join(parent, "home");
  const bin = join(parent, "bin");
  await Promise.all([mkdir(root), mkdir(home), mkdir(bin)]);
  for (const tool of ["node", "npm", "pnpm", "yarn", "bun"])
    await writeFile(join(bin, tool), "fixture executable", { mode: 0o700 });
  fixtures.set(root, { home, bin });
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
  expect(await observe(root)).toEqual([
    { tool: "node", required: "^24.0.0 || >=26", version: "22.18.0" },
    { tool: "pnpm", required: "10.34.7" },
  ]);
  expect(probe.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    [join(fixtures.get(root)?.bin ?? "", "node"), ["--version"]],
    [join(fixtures.get(root)?.bin ?? "", "pnpm"), ["--version"]],
  ]);
  expect(probe.mock.calls[0]?.[2]).not.toBe(root);
  expect(probe.mock.calls[0]?.[3]).toMatchObject({
    PATH: fixtures.get(root)?.bin,
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    YARN_IGNORE_PATH: "1",
    npm_config_ignore_pnpmfile: "true",
  });
  expect(await readdir(fixtures.get(root)?.home ?? root)).toEqual([]);
});
test.each([
  null,
  [],
  {},
  { engines: [] },
  { engines: { node: "$(bad)" }, packageManager: "evil@1.0" },
  { packageManager: 42 },
])("invalid declarations add no probes: %j", async (value) => {
  expect(await observe(await fixture(value))).toEqual([]);
  expect(probe).not.toHaveBeenCalled();
});
test.each(["npm", "pnpm", "yarn", "bun"])(
  "declared %s is observed without running scripts",
  async (tool) => {
    probe.mockResolvedValue("1.2.3");
    expect(await observe(await fixture({ packageManager: `${tool}@1.2.3` }))).toEqual([
      { tool, required: "1.2.3", version: "1.2.3" },
    ]);
  },
);
test("missing, malformed, oversized, symlink and directory manifests are ignored", async () => {
  const root = await fixture();
  const path = join(root, "package.json");
  expect(await observe(root)).toEqual([]);
  await writeFile(path, "{");
  expect(await observe(root)).toEqual([]);
  await writeFile(path, " ".repeat(65537));
  expect(await observe(root)).toEqual([]);
  await rm(path);
  await mkdir(path);
  expect(await observe(root)).toEqual([]);
  expect(probe).not.toHaveBeenCalled();
});
test("untrusted version output stays unknown and cancellation propagates", async () => {
  const root = await fixture({ engines: { node: ">=24" } });
  probe.mockResolvedValue("RAW OUTPUT\nsecret");
  expect(await observe(root)).toEqual([{ tool: "node", required: ">=24" }]);
  const controller = new AbortController();
  probe.mockImplementation(() => {
    controller.abort();
    return Promise.reject(new Error("cancelled"));
  });
  await expect(observe(root, {}, controller.signal)).rejects.toThrow();
});

test.skipIf(process.platform === "win32")("symlink manifests are never followed", async () => {
  const root = await fixture();
  await symlink(join(root, "outside"), join(root, "package.json"));
  expect(await observe(root)).toEqual([]);
  expect(probe).not.toHaveBeenCalled();
});

test("probe failures cannot leave private HOME/cwd directories behind", async () => {
  const root = await fixture({ packageManager: "yarn@1.22.22" });
  const home = fixtures.get(root)?.home;
  probe.mockImplementation(async (_command, _argv, cwd, env) => {
    expect(typeof cwd).toBe("string");
    expect(env).toMatchObject({ HOME: cwd, XDG_CONFIG_HOME: cwd });
    if (typeof cwd !== "string") throw new Error("Invalid fixture cwd");
    expect((await stat(cwd)).isDirectory()).toBe(true);
    throw new Error("probe failed");
  });
  expect(await observe(root)).toEqual([{ tool: "yarn", required: "1.22.22" }]);
  expect(await readdir(home ?? root)).toEqual([]);
});
test("an unsafe home inside the checkout never becomes a probe directory", async () => {
  const root = await fixture({ engines: { node: "24" } });
  expect(await buildFacts(root, {}, root)).toEqual([{ tool: "node", required: "24" }]);
  expect(probe).not.toHaveBeenCalled();
});
test.skipIf(process.platform === "win32")(
  "checkout PATH entries, executable symlinks and missing tools never run",
  async () => {
    const root = await fixture({ packageManager: "yarn@1.22.22" });
    const value = fixtures.get(root);
    if (!value) throw new Error("Missing fixture");
    const checkoutBin = join(root, "bin");
    await mkdir(checkoutBin);
    await writeFile(join(checkoutBin, "yarn"), "bad", { mode: 0o700 });
    const linkedDir = join(value.home, "linked-bin");
    await symlink(checkoutBin, linkedDir);
    await rm(join(value.bin, "yarn"));
    await symlink(join(checkoutBin, "yarn"), join(value.bin, "yarn"));
    expect(
      await observe(root, {
        PATH: [".", checkoutBin, linkedDir, join(value.home, "missing"), value.bin].join(":"),
        NODE_OPTIONS: "--require ./payload.cjs",
      }),
    ).toEqual([{ tool: "yarn", required: "1.22.22" }]);
    expect(probe).not.toHaveBeenCalled();
    await rm(join(value.bin, "yarn"));
    await mkdir(join(value.bin, "yarn"));
    expect(await observe(root)).toEqual([{ tool: "yarn", required: "1.22.22" }]);
    expect(probe).not.toHaveBeenCalled();
  },
);

test.skipIf(process.platform === "win32")(
  "real version probes cannot execute checkout Yarn redirects, plugins or inherited preloads",
  async () => {
    const root = await fixture({ packageManager: "yarn@1.22.22" });
    const value = fixtures.get(root);
    if (!value) throw new Error("Missing fixture");
    const marker = join(root, "executed");
    const observed = join(value.home, "observed.json");
    const payload = join(root, "payload.cjs");
    await writeFile(
      payload,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');console.log('1.22.22');`,
    );
    await writeFile(join(root, ".yarnrc"), 'yarn-path "./payload.cjs"\n');
    await writeFile(join(root, ".yarnrc.yml"), 'plugins:\n  - path: "./payload.cjs"\n');
    await writeFile(
      join(value.home, ".yarnrc.yml"),
      `plugins:\n  - path: ${JSON.stringify(payload)}\n`,
    );
    const script = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
let current=process.cwd();
while(true){
  const rc=path.join(current,'.yarnrc');
  if(fs.existsSync(rc)&&process.env.YARN_IGNORE_PATH!=='1'){
    const target=/yarn-path "([^"]+)"/.exec(fs.readFileSync(rc,'utf8'))?.[1];
    if(target){require(path.resolve(current,target));process.exit(0);}
  }
  const modern=path.join(current,process.env.YARN_RC_FILENAME||'.yarnrc.yml');
  if(fs.existsSync(modern)){
    const target=/path: "([^"]+)"/.exec(fs.readFileSync(modern,'utf8'))?.[1];
    if(target){require(path.resolve(current,target));process.exit(0);}
  }
  const next=path.dirname(current);if(next===current)break;current=next;
}
fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({cwd:process.cwd(),env:process.env}));
console.log('1.22.22');
`;
    const command = join(value.bin, "yarn");
    await writeFile(command, script, { mode: 0o700 });
    const actual = await vi.importActual<typeof Discovery>(
      "../../../../src/terminal-host/remote/agent-discovery",
    );
    // Demonstrate the exploit with the same fixture CLI and real process runner.
    await actual.hostProbe(command, ["--version"], root, { PATH: value.bin });
    expect((await stat(marker)).isFile()).toBe(true);
    await rm(marker);
    probe.mockImplementation(actual.hostProbe);
    expect(
      await observe(root, {
        HOME: root,
        NODE_OPTIONS: `--require ${payload}`,
        NODE_PATH: root,
        INIT_CWD: root,
        YARN_RC_FILENAME: ".yarnrc.yml",
        npm_config_userconfig: join(root, ".npmrc"),
      }),
    ).toEqual([{ tool: "yarn", required: "1.22.22", version: "1.22.22" }]);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    const record: unknown = JSON.parse(
      await (await import("node:fs/promises")).readFile(observed, "utf8"),
    );
    expect(record).toMatchObject({
      env: { YARN_IGNORE_PATH: "1", COREPACK_ENABLE_PROJECT_SPEC: "0" },
    });
    if (
      typeof record !== "object" ||
      record === null ||
      !("cwd" in record) ||
      typeof record.cwd !== "string"
    )
      throw new Error("Missing probe observation");
    expect(dirname(record.cwd)).toBe(value.home);
    expect(basename(record.cwd)).toMatch(/^\.foom-build-probe-/u);
    expect(record).toMatchObject({ env: { HOME: record.cwd, XDG_CONFIG_HOME: record.cwd } });
    if (!("env" in record) || typeof record.env !== "object" || record.env === null)
      throw new Error("Missing probe environment");
    expect("NODE_OPTIONS" in record.env).toBe(false);
    expect("NODE_PATH" in record.env).toBe(false);
    expect("INIT_CWD" in record.env).toBe(false);
    await expect(stat(record.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.skipIf(process.platform === "win32")(
  "an external PATH directory cannot smuggle a checkout Node into a manager shebang",
  async () => {
    const root = await fixture({ packageManager: "yarn@1.22.22" });
    const value = fixtures.get(root);
    if (!value) throw new Error("Missing fixture");
    const payload = join(root, "node");
    await writeFile(payload, "untrusted", { mode: 0o700 });
    await rm(join(value.bin, "node"));
    await symlink(payload, join(value.bin, "node"));
    expect(await observe(root)).toEqual([{ tool: "yarn", required: "1.22.22" }]);
    expect(probe).not.toHaveBeenCalled();
  },
);
test.skipIf(process.platform === "win32")(
  "nonexecutable version commands stay unavailable",
  async () => {
    const root = await fixture({ packageManager: "yarn@1.22.22" });
    const value = fixtures.get(root);
    if (!value) throw new Error("Missing fixture");
    await (await import("node:fs/promises")).chmod(join(value.bin, "yarn"), 0o600);
    expect(await observe(root)).toEqual([{ tool: "yarn", required: "1.22.22" }]);
    expect(probe).not.toHaveBeenCalled();
  },
);

test("a manager binary may live in a PATH directory without a Node binary", async () => {
  const root = await fixture({ packageManager: "yarn@1.22.22" });
  const value = fixtures.get(root);
  if (!value) throw new Error("Missing fixture");
  await rm(join(value.bin, "node"));
  probe.mockResolvedValue("1.22.22");
  expect(await observe(root)).toEqual([{ tool: "yarn", required: "1.22.22", version: "1.22.22" }]);
});
