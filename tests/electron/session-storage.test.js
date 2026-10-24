const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { constants } = require("node:fs");
const {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  statfs,
  writeFile,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { boardPage, launchApp, quitAndWait, removeAfterApps } = require("./harness.js");
const { createSessionData } = require("./session-storage.js");
const { deadline } = require("./test-policy.js");

test("Chromium fixture storage survives restore, stays separate from Foom data and is cleaned after quit", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const paths = await app.evaluate(({ app, session }) => ({
    profile: app.getPath("userData"),
    session: app.getPath("sessionData"),
    storage: session.defaultSession.storagePath,
  }));
  assert.notEqual(await realpath(paths.profile), await realpath(paths.session));
  assert.equal(await realpath(path.dirname(paths.profile)), await realpath(tmpdir()));
  assert.equal(
    await realpath(paths.storage),
    await realpath(paths.session),
    "Override storage before the default session is created",
  );
  if (process.platform === "linux") {
    const filesystem = await statfs("/dev/shm")
      .then(async (information) => {
        await access("/dev/shm", constants.W_OK);
        return information;
      })
      .catch(() => undefined);
    if (
      filesystem?.type === 0x01021994 &&
      filesystem.bavail * filesystem.bsize >= 128 * 1024 * 1024
    )
      assert.equal(await realpath(path.dirname(paths.session)), await realpath("/dev/shm"));
  }
  const page = await boardPage(app);
  await page.evaluate(() => localStorage.setItem("foom-fixture-storage", "kept"));
  await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
  const restored = await launchApp(context, {
    fixture: "restored",
    args: [`--user-data-dir=${paths.profile}`],
  });
  const restoredSession = await restored.evaluate(({ app }) => app.getPath("sessionData"));
  assert.equal(await realpath(restoredSession), await realpath(paths.session));
  const restoredPage = await boardPage(restored);
  assert.equal(
    await restoredPage.evaluate(() => localStorage.getItem("foom-fixture-storage")),
    "kept",
  );
  context.after(async () => {
    await assert.rejects(realpath(paths.session), { code: "ENOENT" });
    await assert.rejects(realpath(paths.profile), { code: "ENOENT" });
  });
});

test("Chromium session storage falls back when shared memory is unavailable", async (context) => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "foom-session-storage-")));
  removeAfterApps(context, temporary);
  for (const platform of ["linux", "darwin", "win32"]) {
    const directory = await createSessionData({
      platform,
      temporary,
      sharedMemory: path.join(temporary, "missing"),
    });
    assert.equal(path.dirname(directory), temporary);
    assert.equal(await realpath(directory), directory);
  }
});

test("Chromium fixture storage is removed when its worker hard-exits", async (context) => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "foom-session-exit-")));
  removeAfterApps(context, temporary);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `const { createSessionData } = require(process.argv[1]);
       const { writeFileSync, writeSync } = require('node:fs');
       const path = require('node:path');
       (async () => {
         const directory = await createSessionData({ temporary: process.argv[2] });
         writeFileSync(path.join(directory, 'browser-state'), Buffer.alloc(1024 * 1024));
         writeSync(1, directory);
         process.exit(1);
       })().catch(error => { console.error(error); process.exit(2); });`,
      require.resolve("./session-storage.js"),
      temporary,
    ],
    { encoding: "utf8", timeout: deadline(10_000) },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 1, child.stderr);
  assert.equal(child.signal, null);
  assert.ok(path.basename(child.stdout).startsWith("foom-chromium-"));
  await assert.rejects(realpath(child.stdout), { code: "ENOENT" });
});

test("Chromium hard-exit cleanup preserves a substituted directory symlink", async (context) => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "foom-session-exit-")));
  removeAfterApps(context, temporary);
  const target = path.join(temporary, "unowned");
  await mkdir(target);
  await writeFile(path.join(target, "keep"), "preserved");
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `const { createSessionData } = require(process.argv[1]);
       const { renameSync, symlinkSync, writeSync } = require('node:fs');
       (async () => {
         const directory = await createSessionData({ platform: 'darwin', temporary: process.argv[2] });
         renameSync(directory, directory + '-moved');
         symlinkSync(process.argv[3], directory, 'junction');
         writeSync(1, directory);
         process.exit(1);
       })().catch(error => { console.error(error); process.exit(2); });`,
      require.resolve("./session-storage.js"),
      temporary,
      target,
    ],
    { encoding: "utf8", timeout: deadline(10_000) },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 1, child.stderr);
  assert.equal((await lstat(child.stdout)).isSymbolicLink(), true);
  assert.equal(await readFile(path.join(target, "keep"), "utf8"), "preserved");
});
