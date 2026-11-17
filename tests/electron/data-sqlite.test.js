const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { launchApp } = require("./harness.js");
const { deadline } = require("./test-policy.js");

test("data SQLite: Drizzle, importer and commit publications run in Electron main without changing JSON authority", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const result = await app.evaluate(async ({ app }, modulePath) => {
    const load = process.getBuiltinModule("node:module").createRequire(modulePath);
    const { ProfileDatabase } = load(modulePath);
    const recoveryCipher = load(process.cwd() + "/tests/electron/sqlite-recovery-cipher.js")();
    const { executeDataCommand } = load(
      load("node:path").join(load("node:path").dirname(modulePath), "commands.js"),
    );
    const { importLegacy } = load(
      load("node:path").join(load("node:path").dirname(modulePath), "importer.js"),
    );
    const { ViewChanges } = load(
      load("node:path").join(load("node:path").dirname(modulePath), "../view-changes.js"),
    );
    const fs = load("node:fs/promises");
    const path = load("node:path");
    const { DatabaseSync } = load("node:sqlite");
    // Nested fixture profile only. The running app keeps its ordinary JSON stores.
    const profile = await fs.mkdtemp(path.join(app.getPath("userData"), "sqlite-fixture-"));
    const source = JSON.stringify({
      version: 2,
      settings: { registeredHosts: [{ host: "fixture", codeFolder: "~/code" }] },
    });
    await fs.writeFile(path.join(profile, "settings.json"), source, { mode: 0o600 });
    await fs.writeFile(
      path.join(profile, "sessions.json"),
      JSON.stringify([
        {
          id: "remote",
          agent: "codex",
          repository: "/repo",
          worktree: "/repo",
          branch: "main",
          remote: true,
          placement: { kind: "remote", host: "fixture" },
        },
      ]),
      { mode: 0o600 },
    );
    const changes = new ViewChanges();
    const snapshots = [];
    const db = await ProfileDatabase.open(profile, changes, recoveryCipher);
    const off = changes.subscribe((views) => {
      const raw = new DatabaseSync(path.join(profile, "data/profile.sqlite"));
      try {
        snapshots.push({
          views: [...views],
          count: raw.prepare("SELECT count(*) AS count FROM hosts").get().count,
        });
      } finally {
        raw.close();
      }
    });
    try {
      const start = performance.now();
      const imported = await importLegacy(db, profile);
      const latency = performance.now() - start;
      let refused = false;
      const raw = new DatabaseSync(path.join(profile, "data/profile.sqlite"));
      try {
        raw.exec("PRAGMA foreign_keys=ON");
        try {
          raw.exec("DELETE FROM hosts");
        } catch {
          refused = true;
        }
      } finally {
        raw.close();
      }
      await executeDataCommand(db, { type: "forget-host", host: "fixture" });
      return {
        imported,
        refused,
        latency,
        snapshots,
        original: await fs.readFile(path.join(profile, "settings.json"), "utf8"),
        source,
      };
    } finally {
      off();
      await db.close();
    }
  }, path.resolve("build/main/data/sqlite/database.js"));
  assert.equal(result.refused, true);
  assert.equal(result.imported.value.alreadyImported, false);
  assert.equal(JSON.parse(result.imported.value.report).quarantined, 0);
  assert.equal(result.original, result.source);
  assert.deepEqual(
    result.snapshots.map((row) => row.count),
    [1, 0],
  );
  assert.ok(result.snapshots[0].views.includes("sessions"));
  context.diagnostic(
    `SQLite importer commit-to-publication including file preparation: ${result.latency.toFixed(1)} ms`,
  );
});

test("data SQLite: profile settings and consent import preserve JSON and publish after commit", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const result = await app.evaluate(async ({ app }, modulePath) => {
    const load = process.getBuiltinModule("node:module").createRequire(modulePath);
    const { ProfileDatabase } = load(modulePath);
    const recoveryCipher = load(process.cwd() + "/tests/electron/sqlite-recovery-cipher.js")();
    const { importProfileSettings, saveProfileSettings, saveAgentConsent } = load("./settings.js");
    const fs = load("node:fs/promises");
    const path = load("node:path");
    const { DatabaseSync } = load("node:sqlite");
    const profile = await fs.mkdtemp(path.join(app.getPath("userData"), "sqlite-settings-"));
    const original = JSON.stringify({
      version: 2,
      settings: {
        terminalClipboardWrites: false,
        agentBypassAcknowledged: { "custom-agent": true },
      },
    });
    await fs.writeFile(path.join(profile, "settings.json"), original, { mode: 0o600 });
    const pushed = [];
    const db = await ProfileDatabase.open(
      profile,
      {
        publish(...views) {
          const connection = new DatabaseSync(path.join(profile, "data/profile.sqlite"));
          try {
            pushed.push({
              views,
              value: connection
                .prepare("SELECT value FROM profile_settings WHERE key='terminalClipboardWrites'")
                .get()?.value,
            });
          } finally {
            connection.close();
          }
        },
      },
      recoveryCipher,
    );
    try {
      await importProfileSettings(db, profile);
      await saveProfileSettings(db, { terminalClipboardWrites: true });
      await saveAgentConsent(db, "custom-agent", true, null);
      const connection = new DatabaseSync(path.join(profile, "data/profile.sqlite"));
      try {
        return {
          pushed,
          consent: connection.prepare("SELECT identity FROM agent_consents").get().identity,
          unchanged: (await fs.readFile(path.join(profile, "settings.json"), "utf8")) === original,
        };
      } finally {
        connection.close();
      }
    } finally {
      await db.close();
    }
  }, path.resolve("build/main/data/sqlite/database.js"));
  assert.equal(result.unchanged, true);
  assert.equal(result.consent, null);
  assert.deepEqual(
    result.pushed.map((row) => row.value),
    ["false", "true", "true"],
  );
  assert.ok(result.pushed.every((row) => row.views.includes("settings")));
});

test("data SQLite: Environment uses native safeStorage or refuses secrets without storing plaintext", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const result = await app.evaluate(async ({ app, safeStorage }, modulePath) => {
    const load = process.getBuiltinModule("node:module").createRequire(modulePath);
    const { ProfileDatabase } = load(modulePath);
    const recoveryCipher = load(process.cwd() + "/tests/electron/sqlite-recovery-cipher.js")();
    const api = load("./environment.js");
    const { safeStorageCipher } = load("../../setup/environment.js");
    const fs = load("node:fs/promises");
    const path = load("node:path");
    const { DatabaseSync } = load("node:sqlite");
    const profile = await fs.mkdtemp(path.join(app.getPath("userData"), "sqlite-environment-"));
    const original = JSON.stringify({
      version: 1,
      lists: { all: [{ name: "VISIBLE", value: "plain" }] },
    });
    await fs.writeFile(path.join(profile, "environment.json"), original, { mode: 0o600 });
    const db = await ProfileDatabase.open(profile, undefined, recoveryCipher);
    const cipher = safeStorageCipher(safeStorage);
    try {
      await api.importDatabaseEnvironment(db, profile, cipher);
      let refusal;
      try {
        await api.saveDatabaseEnvironment(db, cipher, {
          scope: "all",
          previous: null,
          name: "SECRET",
          value: "private-sqlite-fixture-secret",
          secret: true,
        });
      } catch (error) {
        refusal = error.message;
      }
      const state = await api.readDatabaseEnvironment(db, cipher);
      const connection = new DatabaseSync(path.join(profile, "data/profile.sqlite"));
      try {
        const row = connection
          .prepare("SELECT value,cipher FROM environment_entries WHERE name='SECRET'")
          .get();
        return {
          refusal,
          masked: !JSON.stringify(state).includes("private-sqlite-fixture-secret"),
          value: row?.value,
          cipherPresent: Boolean(row?.cipher),
          unchanged:
            (await fs.readFile(path.join(profile, "environment.json"), "utf8")) === original,
        };
      } finally {
        connection.close();
      }
    } finally {
      await db.close();
    }
  }, path.resolve("build/main/data/sqlite/database.js"));
  assert.equal(result.masked, true);
  assert.equal(result.unchanged, true);
  if (result.refusal) {
    assert.match(result.refusal, /keychain/);
    assert.equal(result.cipherPresent, false);
  } else {
    assert.equal(result.value, null);
    assert.equal(result.cipherPresent, true);
  }
});

test("data SQLite: board and control recovery preserve history without replay or credential restoration", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const result = await app.evaluate(async ({ app }, modulePath) => {
    const load = process.getBuiltinModule("node:module").createRequire(modulePath);
    const { ProfileDatabase } = load(modulePath);
    const recoveryCipher = load(process.cwd() + "/tests/electron/sqlite-recovery-cipher.js")();
    const api = load("./control.js");
    const { privateDirectory, atomicPrivate } = load("../../../node-common/private-files.js");
    const fs = load("node:fs/promises");
    const path = load("node:path");
    const { DatabaseSync } = load("node:sqlite");
    const profile = await fs.mkdtemp(path.join(app.getPath("userData"), "sqlite-control-"));
    const directory = await privateDirectory(profile);
    const now = new Date().toISOString();
    const id = "11111111-1111-4111-8111-111111111111";
    const record = {
      actor: {
        grantedAt: now,
        generation: "generation",
        sessionId: "session",
        repository: "/repo",
        worktree: "/repo",
        terminalId: "parent",
        parentId: null,
        role: "orchestrator",
      },
      key: "a".repeat(64),
      fingerprint: "b".repeat(64),
      operation: {
        operationId: id,
        action: "prompt",
        targetId: "child",
        resultId: null,
        status: "running",
        createdAt: now,
        updatedAt: now,
        reason: "intent",
        inputHash: "c".repeat(64),
      },
      token: "never-store-this-token",
    };
    await atomicPrivate(directory, `operation-${id}.json`, record);
    await atomicPrivate(directory, "board.json", {
      version: 1,
      threads: [
        {
          id: "thread",
          title: "Topic",
          repository: "historical-repository",
          to: ["other-repository"],
          state: "open",
          createdAt: now,
          updatedAt: now,
        },
      ],
      posts: [
        {
          id: "post",
          thread: "thread",
          author: "human",
          kind: "fyi",
          text: "Shared history",
          links: [],
          timestamp: now,
        },
      ],
      receipts: [],
    });
    const db = await ProfileDatabase.open(profile, undefined, recoveryCipher);
    try {
      await api.importDatabaseControl(db, profile);
      let replayRefused = false;
      try {
        await api.reserveDatabaseOperation(db, record);
      } catch {
        replayRefused = true;
      }
      await api.clearDatabaseAudit(db);
      const raw = new DatabaseSync(path.join(profile, "data/profile.sqlite"));
      try {
        const operation = raw.prepare("SELECT status,recovered,data FROM control_operations").get();
        return {
          replayRefused,
          recoveryEncrypted: !(
            await fs.readFile(path.join(profile, "data/recovery/control-history-v1.json"), "utf8")
          ).includes("never-store-this-token"),
          operation,
          posts: raw.prepare("SELECT * FROM board_posts").all().length,
          audits: raw.prepare("SELECT * FROM audit_records").all().length,
          unchanged:
            JSON.parse(await fs.readFile(path.join(directory, `operation-${id}.json`), "utf8"))
              .operation.status === "running",
        };
      } finally {
        raw.close();
      }
    } finally {
      await db.close();
    }
  }, path.resolve("build/main/data/sqlite/database.js"));
  assert.equal(result.replayRefused, true);
  assert.equal(result.recoveryEncrypted, true);
  assert.equal(result.unchanged, true);
  assert.equal(result.operation.status, "indeterminate");
  assert.equal(result.operation.recovered, 1);
  assert.equal(result.operation.data.includes("never-store-this-token"), false);
  assert.equal(result.posts, 1);
  assert.equal(result.audits, 0);
});

test("data SQLite: window and update metadata import without changing production files or granting preview network", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const result = await app.evaluate(async ({ app }, modulePath) => {
    const load = process.getBuiltinModule("node:module").createRequire(modulePath);
    const { ProfileDatabase } = load(modulePath);
    const recoveryCipher = load(process.cwd() + "/tests/electron/sqlite-recovery-cipher.js")();
    const api = load("./windows.js");
    const fs = load("node:fs/promises");
    const path = load("node:path");
    const { DatabaseSync } = load("node:sqlite");
    const profile = await fs.mkdtemp(path.join(app.getPath("userData"), "sqlite-windows-"));
    const original = JSON.stringify([
      {
        id: "saved",
        display: 1,
        bounds: { x: -100, y: 0, width: 1000, height: 700 },
        maximized: false,
      },
    ]);
    await fs.writeFile(path.join(profile, "windows.json"), original, { mode: 0o600 });
    await fs.writeFile(
      path.join(profile, "previews-saved.json"),
      JSON.stringify([
        { id: "a".repeat(32), worktree: "/saved-claim", relativePath: "readme.md", network: false },
      ]),
      { mode: 0o600 },
    );
    const db = await ProfileDatabase.open(profile, undefined, recoveryCipher);
    try {
      const imported = await api.importDatabaseWindows(db, profile);
      const first = await api.reserveDatabaseUpdateActivity(db, new Date("2026-11-17T12:00:00Z"));
      const second = await api.reserveDatabaseUpdateActivity(db, new Date("2026-11-17T12:00:00Z"));
      const raw = new DatabaseSync(path.join(profile, "data/profile.sqlite"));
      let preview;
      let refused = false;
      try {
        raw.exec("PRAGMA foreign_keys=ON");
        preview = raw.prepare("SELECT * FROM preview_records").get();
        try {
          raw.exec("DELETE FROM windows");
        } catch {
          refused = true;
        }
      } finally {
        raw.close();
      }
      await api.saveDatabaseWindows(db, []);
      return {
        report: JSON.parse(imported.value.report),
        first: first.value,
        second: second.value,
        preview,
        refused,
        original,
        after: await fs.readFile(path.join(profile, "windows.json"), "utf8"),
      };
    } finally {
      await db.close();
    }
  }, path.resolve("build/main/data/sqlite/database.js"));
  assert.equal(result.report.quarantined, 0);
  assert.equal(result.preview.network, 0);
  assert.equal(result.preview.worktree, null);
  assert.equal(result.refused, true);
  assert.equal(result.first, "?d=1&w=1&m=1");
  assert.equal(result.second, "");
  assert.equal(result.after, result.original);
});

test("data SQLite: report cold process to first renderer view and write to renderer view measurements", {
  timeout: deadline(90_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const result = await app.evaluate(
    async ({ app }, { modulePath, fixturePath, childTimeoutMs }) => {
      const load = process.getBuiltinModule("node:module").createRequire(modulePath);
      const { ProfileDatabase } = load(modulePath);
      const { ViewChanges } = load("../view-changes.js");
      const tables = load("./schema.js");
      const fs = load("node:fs/promises");
      const path = load("node:path");
      const { execFile } = load("node:child_process");
      const { electronLaunch } = load(path.join(path.dirname(fixturePath), "display-isolation.js"));
      const cold = [];
      const writes = [];
      for (let sample = 0; sample < 10; sample++) {
        const root = await fs.mkdtemp(path.join(app.getPath("userData"), "sqlite-measurement-"));
        const db = await ProfileDatabase.open(root, new ViewChanges());
        try {
          await db.write((tx) => {
            for (let index = 0; index < 1000; index++)
              tx.insert(tables.repositories)
                .values({ path: path.join(root, `repository-${String(index).padStart(4, "0")}`) })
                .run();
          });
        } finally {
          await db.close();
        }
        await fs.writeFile(
          path.join(root, "view.html"),
          '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'"><body>Loading<script src="view.js"></script>',
        );
        await fs.writeFile(
          path.join(root, "view.js"),
          "window.measurement.receive(value => { document.body.textContent = JSON.stringify(value.data); });",
        );
        await fs.writeFile(
          path.join(root, "preload.js"),
          `const {contextBridge,ipcRenderer}=require("electron");
        const channel=process.argv.find(arg=>arg.startsWith("--sqlite-measurement-channel=")).slice("--sqlite-measurement-channel=".length);
        contextBridge.exposeInMainWorld("measurement",{receive(callback){
          ipcRenderer.on(channel,(_event,value)=>{
            if(!value || value.id!=="measurement" || value.view!=="repositories" || !Number.isSafeInteger(value.generation) || !Number.isSafeInteger(value.revision) || !Array.isArray(value.data) || value.data.length!==100 || !value.data.every(row=>row && typeof row.path==="string" && row.path.length<=4096 && typeof row.name==="string" && row.name.length<=4096))throw Error("Invalid fixture snapshot");
            callback(value);ipcRenderer.send(channel, {generation:value.generation,revision:value.revision,first:value.data[0].name});
          });ipcRenderer.send(channel,"ready");
        }});`,
        );
        try {
          const options = electronLaunch({
            env: { ...process.env, HOME: root, USERPROFILE: root },
            args: [fixturePath, modulePath, root],
          });
          const start = performance.timeOrigin + performance.now();
          const stdout = await new Promise((resolve, reject) =>
            execFile(
              process.execPath,
              options.args,
              { env: options.env, cwd: root, maxBuffer: 1024 * 1024, timeout: childTimeoutMs },
              (error, stdout) => (error ? reject(error) : resolve(stdout)),
            ),
          );
          const line = stdout.split("\n").find((line) => line.startsWith("SQLITE_MEASUREMENT "));
          if (!line) throw Error("Missing measurement result");
          const measured = JSON.parse(line.slice("SQLITE_MEASUREMENT ".length));
          cold.push(measured.firstViewAt - start);
          writes.push(measured.writeToViewMs);
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
      function summarize(values) {
        const sorted = [...values].sort((a, b) => a - b);
        return {
          p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
          p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
          samplesMs: values,
        };
      }
      return {
        platform: process.platform,
        arch: process.arch,
        versions: {
          electron: process.versions.electron,
          node: process.versions.node,
          sqlite: process.versions.sqlite,
        },
        workload: { samples: 10, repositories: 1000, pageSize: 100, writesPerSample: 1 },
        scope:
          "Cold fixture Electron process spawn through SQLite open and first sandboxed renderer view; OS caches retained. ViewRegistry delivery includes renderer DOM update and receipt acknowledgement. Seed and fixture file creation excluded. Nearest-rank percentiles; reporting only. Production Foom startup remains JSON-backed.",
        coldStartToFirstView: summarize(cold),
        writeToView: summarize(writes),
      };
    },
    {
      modulePath: path.resolve("build/main/data/sqlite/database.js"),
      fixturePath: path.resolve("tests/electron/sqlite-measurement-fixture.js"),
      childTimeoutMs: deadline(30_000),
    },
  );
  context.diagnostic(`SQLite view measurements (no latency thresholds): ${JSON.stringify(result)}`);
  const fs = require("node:fs/promises");
  await fs.mkdir("test-results", { recursive: true });
  await fs.writeFile(
    `test-results/data-sqlite-measurements-${process.platform}.json`,
    JSON.stringify(result, null, 2),
  );
  assert.equal(result.coldStartToFirstView.samplesMs.length, 10);
  assert.equal(result.writeToView.samplesMs.length, 10);
});
