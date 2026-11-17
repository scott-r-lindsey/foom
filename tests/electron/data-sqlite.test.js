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
    const db = await ProfileDatabase.open(profile, changes);
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
    const db = await ProfileDatabase.open(profile, {
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
    });
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
