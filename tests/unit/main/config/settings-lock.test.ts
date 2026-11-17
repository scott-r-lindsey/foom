import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, test, vi } from "vitest";
import { ConfigFiles } from "../../../../src/main/config/files";
import { fixture } from "./service-fixture";

const lockName = ".foom-settings.lock";
const owner = (patch: object = {}) =>
  JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    start: null,
    token: "fixture-owner",
    timestamp: Date.now(),
    ...patch,
  });
async function setup() {
  const f = await fixture();
  await f.service.initialize();
  return { ...f, files: new ConfigFiles({ root: f.folder }), lock: join(f.folder, lockName) };
}

test("live and foreign-host owners never expire; permission failures fail closed", async () => {
  const f = await setup();
  for (const record of [
    owner(),
    owner({ hostname: "another-host", start: "old" }),
    JSON.stringify({ hostname: "another-host" }),
  ]) {
    await writeFile(f.lock, record);
    await utimes(f.lock, 0, 0);
    await expect(f.service.write({ concurrentChildren: 8 })).rejects.toThrow("settings are busy");
    expect(await readFile(f.lock, "utf8")).toBe(record);
  }
  await writeFile(f.lock, owner());
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("denied"), { code: "EPERM" });
  });
  try {
    await expect(f.files.withSettingsLock(async () => {})).rejects.toThrow("settings are busy");
  } finally {
    kill.mockRestore();
  }
});

test.skipIf(process.platform !== "linux")(
  "a reused PID is recovered using the process start identity",
  async () => {
    const f = await setup();
    await writeFile(f.lock, owner({ start: "a-different-boot:1" }));
    await f.service.write({ concurrentChildren: 8 });
    expect(JSON.parse(await f.read("settings.json"))).toMatchObject({ concurrentChildren: 8 });
    expect(await readdir(f.folder)).not.toContain(lockName);
  },
);

test("recent corrupt records fail closed; readable corrupt records recover after 24 hours", async () => {
  const f = await setup();
  for (const record of ["", "{broken", "{}", owner({ pid: -1 }), owner({ start: 42 })]) {
    await writeFile(f.lock, record);
    await expect(f.files.withSettingsLock(async () => {})).rejects.toThrow("settings are busy");
    await utimes(f.lock, 0, 0);
    await f.files.withSettingsLock(async () => {});
  }
  await mkdir(f.lock);
  await utimes(f.lock, 0, 0);
  await expect(f.files.withSettingsLock(async () => {})).rejects.toThrow("settings are busy");
});

test("release preserves a replacement owner's token, including after work fails", async () => {
  const f = await setup();
  const replacement = owner({ token: "replacement" });
  await expect(
    f.files.withSettingsLock(async () => {
      await writeFile(f.lock, replacement);
      throw new Error("work failed");
    }),
  ).rejects.toThrow("work failed");
  expect(await readFile(f.lock, "utf8")).toBe(replacement);
});

test("a crashed recovery owner is recovered before the settings lock", async () => {
  const f = await setup();
  await writeFile(f.lock, "");
  await writeFile(`${f.lock}.recovery`, "");
  await utimes(f.lock, 0, 0);
  await utimes(`${f.lock}.recovery`, 0, 0);
  await f.service.write({ concurrentChildren: 8 });
  expect(await readdir(f.folder)).not.toContain(`${lockName}.recovery`);
});

test("SIGKILL of a lock owner permits a fresh instance to save; two processes race takeover safely", async () => {
  const f = await setup();
  const bundle = join(f.root, "files.cjs");
  await build({
    entryPoints: ["src/main/config/files.ts"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const worker = join(f.root, "worker.cjs");
  await writeFile(
    worker,
    `
const { ConfigFiles } = require(${JSON.stringify(bundle)});
const files = new ConfigFiles({ root: process.argv[2] });
const kill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (pid === Number(process.argv[3]) && signal === 0) process.send('observed-stale');
  return kill(pid, signal);
};
process.on('message', async (mode) => {
  try {
    await files.withSettingsLock(async () => {
      if (mode === 'hold') {
        process.send('acquired');
        await new Promise(() => {});
      } else {
        const current = JSON.parse((await files.read('settings.json')).toString());
        await new Promise(r => setTimeout(r, 40));
        await files.writeFile('settings.json', JSON.stringify({ ...current, concurrentChildren: current.concurrentChildren + 1 }));
      }
    });
    process.exit(0);
  } catch (error) { console.error(error); process.exit(1); }
});
process.send('ready');
`,
  );
  const children: ReturnType<typeof fork>[] = [];
  try {
    const launch = async (deadPid = "") => {
      const child = fork(resolve(worker), [f.folder, deadPid], {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      children.push(child);
      await once(child, "message");
      return child;
    };
    const holder = await launch();
    const acquired = once(holder, "message");
    holder.send("hold");
    expect((await acquired)[0]).toBe("acquired");
    const exited = once(holder, "exit");
    holder.kill("SIGKILL");
    await exited;
    // A new service instance (not the original owning profile) can now save.
    const fresh = await fixture({ root: f.folder });
    await fresh.service.initialize();
    await fresh.service.write({ concurrentChildren: 8 });
    // Recreate the dead owner's record for two independent takeover contenders.
    await writeFile(f.lock, owner({ pid: holder.pid }));
    // Hold the recovery gate until both contenders have inspected the dead
    // owner, forcing both to race the same stale snapshot.
    await writeFile(`${f.lock}.recovery`, owner());
    const [first, second] = await Promise.all([
      launch(String(holder.pid)),
      launch(String(holder.pid)),
    ]);
    const observed = [once(first, "message"), once(second, "message")];
    const exits = [once(first, "exit"), once(second, "exit")];
    first.send("save");
    second.send("save");
    await Promise.all(observed);
    await rm(`${f.lock}.recovery`);
    expect(await Promise.all(exits)).toEqual([
      [0, null],
      [0, null],
    ]);
    expect(JSON.parse(await f.read("settings.json"))).toMatchObject({ concurrentChildren: 10 });
    expect(await readdir(f.folder)).not.toContain(lockName);
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }),
    );
    await rm(bundle, { force: true });
  }
}, 15000);
