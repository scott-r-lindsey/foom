import * as fs from "node:fs/promises";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, test, vi } from "vitest";
import { ConfigFiles } from "../../../../src/main/config/files";
import { fixture } from "./service-fixture";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));

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
    await expect(f.service.write({ concurrentChildren: 8 })).rejects.toThrow(
      "foom-error:settings-busy",
    );
    expect(await readFile(f.lock, "utf8")).toBe(record);
  }
  await writeFile(f.lock, owner());
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("denied"), { code: "EPERM" });
  });
  try {
    await expect(f.files.withSettingsLock(async () => {})).rejects.toThrow(
      "foom-error:settings-busy",
    );
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

test.each(["", "{broken", "{}", owner({ pid: -1 }), owner({ start: 42 })])(
  "corrupt record %j fails closed regardless of age",
  async (record) => {
    const f = await setup();
    await writeFile(f.lock, record);
    await expect(f.files.withSettingsLock(async () => {})).rejects.toThrow(
      "foom-error:settings-lock-corrupt",
    );
    await utimes(f.lock, 0, 0);
    await expect(f.files.withSettingsLock(async () => {})).rejects.toThrow(
      "foom-error:settings-lock-corrupt",
    );
    expect(await readFile(f.lock, "utf8")).toBe(record);
  },
);

test("an old nonregular lock fails closed", async () => {
  const f = await setup();
  await mkdir(f.lock);
  await utimes(f.lock, 0, 0);
  await expect(f.files.withSettingsLock(async () => {})).rejects.toThrow(
    "foom-error:settings-lock-corrupt",
  );
});

test("a writer paused before its record write cannot enter beside an owner after a 24-hour clock jump", async () => {
  const f = await setup();
  const opened = Promise.withResolvers<undefined>();
  const resume = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const acquired = Promise.withResolvers<undefined>();
  const originalOpen = fs.open;
  vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    const file = await originalOpen(...args);
    opened.resolve(undefined);
    await resume.promise;
    return file;
  });
  let active = 0;
  let maximum = 0;
  const firstWork = vi.fn(() => {
    maximum = Math.max(maximum, ++active);
    active--;
    return Promise.resolve();
  });
  const first = f.files.withSettingsLock(firstWork);
  await opened.promise;
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 25 * 60 * 60 * 1000);
  const second = f.files.withSettingsLock(async () => {
    maximum = Math.max(maximum, ++active);
    acquired.resolve(undefined);
    await release.promise;
    active--;
  });
  try {
    await acquired.promise;
    resume.resolve(undefined);
    await expect(first).rejects.toThrow("foom-error:settings-busy");
    expect(firstWork).not.toHaveBeenCalled();
    expect(maximum).toBe(1);
  } finally {
    resume.resolve(undefined);
    release.resolve(undefined);
    await Promise.allSettled([first, second]);
  }
  expect((await readdir(f.folder)).filter((name) => name.startsWith(".foom-"))).toEqual([]);
});

test("ownership is checked after publication before entering the callback", async () => {
  const f = await setup();
  const originalLink = fs.link;
  const replacement = owner({ token: "replacement" });
  vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
    await originalLink(...args);
    await writeFile(f.lock, replacement);
  });
  const work = vi.fn(async () => {});
  await expect(f.files.withSettingsLock(work)).rejects.toThrow("foom-error:settings-busy");
  expect(work).not.toHaveBeenCalled();
  expect(await readFile(f.lock, "utf8")).toBe(replacement);
});

for (const stage of ["writeFile", "sync", "link"] as const) {
  test(`failed lock ${stage} never enters work or leaves a published lock`, async () => {
    const f = await setup();
    const failure = new Error("fixture publication failure");
    if (stage === "link") vi.spyOn(fs, "link").mockRejectedValueOnce(failure);
    else {
      const originalOpen = fs.open;
      vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
        const file = await originalOpen(...args);
        vi.spyOn(file, stage).mockRejectedValueOnce(failure);
        return file;
      });
    }
    const work = vi.fn(async () => {});
    await expect(f.files.withSettingsLock(work)).rejects.toThrow(failure);
    expect(work).not.toHaveBeenCalled();
    expect((await readdir(f.folder)).filter((name) => name.startsWith(".foom-"))).toEqual([]);
  });
}

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
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("dead fixture owner"), { code: "ESRCH" });
  });
  await writeFile(f.lock, owner());
  await writeFile(`${f.lock}.recovery`, owner());
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

for (const recovery of [false, true]) {
  test(`temporary EPERM after ${recovery ? "recovery" : "settings"} publication still releases ownership`, async () => {
    const f = await setup();
    if (recovery) {
      await writeFile(f.lock, owner({ pid: 2147483647 }));
    }
    const originalRm = fs.rm;
    const originalLink = fs.link;
    let published = false;
    let denied = false;
    vi.spyOn(fs, "link").mockImplementation(async (...args) => {
      await originalLink(...args);
      if (args[1] === (recovery ? `${f.lock}.recovery` : f.lock)) published = true;
    });
    vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (published && !denied && String(args[0]).endsWith(".tmp")) {
        denied = true;
        throw Object.assign(new Error("scanner"), { code: "EPERM" });
      }
      return originalRm(...args);
    });
    const work = vi.fn(() => Promise.resolve("saved"));
    await expect(f.files.withSettingsLock(work)).resolves.toBe("saved");
    expect(denied).toBe(true);
    expect(work).toHaveBeenCalledTimes(1);
    expect((await readdir(f.folder)).filter((name) => name.startsWith(".foom-"))).toEqual([]);
    await expect(f.files.withSettingsLock(() => Promise.resolve("again"))).resolves.toBe("again");
  });
}

test.each(["EPERM", "EBUSY", "EACCES"])(
  "persistent %s temporary cleanup is best effort",
  async (code) => {
    const f = await setup();
    const originalRm = fs.rm;
    const cleanup = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith(".tmp")) throw Object.assign(new Error("scanner"), { code });
      return originalRm(...args);
    });
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(f.files.withSettingsLock(() => Promise.resolve("saved"))).resolves.toBe("saved");
    expect(log).toHaveBeenCalledTimes(1);
    expect(cleanup.mock.calls.filter(([path]) => String(path).endsWith(".tmp"))).toHaveLength(
      code === "EACCES" ? 1 : 5,
    );
    const names = await readdir(f.folder);
    expect(names).not.toContain(lockName);
    expect(names.filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
  },
);

test("later acquisitions sweep only complete temporary records owned by dead same-host processes", async () => {
  const f = await setup();
  const records = [
    owner({ pid: 2147483647 }),
    owner(),
    owner({ hostname: "other-host" }),
    "{partial",
    "{}",
  ];
  const names = records.map(
    (_, index) => `.foom-00000000-0000-0000-0000-${String(index).padStart(12, "0")}.tmp`,
  );
  await Promise.all(
    records.map((record, index) => writeFile(join(f.folder, names[index] ?? ""), record)),
  );
  await f.files.withSettingsLock(async () => {});
  const remaining = await readdir(f.folder);
  expect(remaining).not.toContain(names[0]);
  for (const name of names.slice(1)) expect(remaining).toContain(name);
});

test.each(["ENOTSUP", "EOPNOTSUPP", "ENOSYS"])(
  "unsupported hard links (%s) select a fixed code",
  async (code) => {
    const f = await setup();
    vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("private path"), { code }));
    await expect(f.files.withSettingsLock(async () => {})).rejects.toThrow(
      "foom-error:settings-lock-unsupported",
    );
    expect((await readdir(f.folder)).filter((name) => name.startsWith(".foom-"))).toEqual([]);
  },
);

test("attaches deferred Settings under the shared lock once startup is current", async () => {
  const baseline = JSON.stringify({ kind: "settings", interfaceScale: 90 });
  const f = await fixture({
    baseline: (await import("../../../../src/main/config/layout")).digest(baseline),
    appliedText: baseline,
  });
  await mkdir(f.folder);
  await f.settings({ interfaceScale: 110 });
  const lock = join(f.folder, lockName);
  await writeFile(lock, owner());
  const attach = vi.fn(() =>
    readFile(lock, "utf8").then((record) => {
      expect(JSON.parse(record)).toHaveProperty("pid", process.pid);
      expect(record).not.toBe(owner());
    }),
  );
  await expect(f.service.initialize(undefined, attach)).resolves.toEqual({ interfaceScale: 90 });
  expect(attach).not.toHaveBeenCalled();
  await f.service.refresh();
  expect(f.applied.at(-1)).toEqual({ interfaceScale: 90 });
  await rm(lock);
  await expect(f.service.finishSettingsStartup(attach, () => false)).resolves.toBe(false);
  const current = vi
    .fn()
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(true)
    .mockReturnValue(false);
  await expect(f.service.finishSettingsStartup(attach, current)).resolves.toBe(false);
  expect(attach).not.toHaveBeenCalled();
  await expect(f.service.finishSettingsStartup(attach, () => true)).resolves.toBe(true);
  expect(attach).toHaveBeenCalledExactlyOnceWith({ interfaceScale: 110 }, expect.any(AbortSignal));
  await expect(f.service.finishSettingsStartup(attach, () => true)).resolves.toBe(true);
  expect(attach).toHaveBeenCalledOnce();
});

test.each(["cancel", "failure"] as const)(
  "deferred attachment releases the Settings lock after %s",
  async (outcome) => {
    const f = await fixture();
    await mkdir(f.folder);
    await f.settings({ interfaceScale: 110 });
    const lock = join(f.folder, lockName);
    await writeFile(lock, owner());
    const entered = Promise.withResolvers<AbortSignal>();
    const completion = Promise.withResolvers<undefined>();
    const attach = (_values: unknown, signal: AbortSignal) => {
      entered.resolve(signal);
      return completion.promise;
    };
    await f.service.initialize(undefined, attach);
    await rm(lock);
    const pending = f.service.finishSettingsStartup(attach, () => true);
    const signal = await entered.promise;
    if (outcome === "cancel") {
      await f.service.dispose();
      expect(signal.aborted).toBe(true);
      await expect(pending).resolves.toBe(false);
      completion.resolve(undefined);
    } else {
      const error = new Error("Fixture profile write failed");
      completion.reject(error);
      await expect(pending).rejects.toBe(error);
      await f.settings({ interfaceScale: 120 });
      await f.service.refresh();
      expect(f.applied.at(-1)).toEqual({ interfaceScale: 120 });
    }
    expect(await readdir(f.folder)).not.toContain(lockName);
  },
);
