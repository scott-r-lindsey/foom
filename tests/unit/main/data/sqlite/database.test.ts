import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { ProfileDatabase, assertForeignKeys } from "../../../../../src/main/data/sqlite/database";
import type { DataCommand } from "../../../../../src/main/data/sqlite/commands";
import { executeDataCommand } from "../../../../../src/main/data/sqlite/commands";
import { importLegacy, importRows } from "../../../../../src/main/data/sqlite/importer";
import { ViewChanges } from "../../../../../src/main/data/view-changes";
import { ViewRegistry } from "../../../../../src/main/data/view-registry";
import { registeredHosts } from "../../../../../src/shared/registered-hosts";
import type { ViewSnapshot } from "../../../../../src/shared/data-views";
import * as tables from "../../../../../src/main/data/sqlite/schema";

vi.mock("../../../../../src/node-common/private-file-permissions", () => ({ windowsAcl: vi.fn() }));
const roots: string[] = [];
const connections: ProfileDatabase[] = [];
afterEach(async () => {
  for (const db of connections.splice(0)) await db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(publications = new ViewChanges()) {
  const profile = await mkdtemp(join(tmpdir(), "foom-sqlite-"));
  roots.push(profile);
  const db = await ProfileDatabase.open(profile, publications);
  connections.push(db);
  return { profile, db, file: join(profile, "data/profile.sqlite"), publications };
}
const repo = join(tmpdir(), "repo");
const tree = { path: join(repo, "child"), repository: repo, root: repo, identity: "identity" };
const session = {
  id: "parent",
  agent: "codex",
  repository: repo,
  worktree: tree.path,
  branch: "main",
};
const remote = {
  ...session,
  id: "remote",
  remote: true,
  placement: { kind: "remote", host: "example" },
};
const sources = (sessions: unknown = [session]) => ({
  "settings.json": JSON.stringify({
    version: 2,
    settings: { registeredHosts: [{ host: "example", codeFolder: "~/code" }] },
  }),
  "worktrees.json": JSON.stringify({
    version: 1,
    repositories: [repo],
    registrations: [{ path: repo, id: "12345678-1234-1234-1234-123456789abc" }],
    managed: [tree],
    parents: [{ path: join(repo, "parent"), identity: "dir" }],
    pendingRemovals: [{ ...tree, path: join(repo, "removed"), directoryIdentity: "dir" }],
  }),
  "sessions.json": JSON.stringify(sessions),
});
async function put(profile: string, input = sources()) {
  for (const [name, contents] of Object.entries(input))
    await writeFile(join(profile, name), contents, { mode: 0o600 });
}
function inspect<T>(file: string, action: (db: DatabaseSync) => T) {
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA foreign_keys=ON");
  try {
    return action(raw);
  } finally {
    raw.close();
  }
}

test("startup enforces FK readback and deploys STRICT tables with all three change triggers", async () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys=OFF");
  try {
    expect(() => {
      assertForeignKeys(raw);
    }).toThrow("foreign_keys=ON");
    raw.exec("PRAGMA foreign_keys=ON");
    assertForeignKeys(raw);
  } finally {
    raw.close();
  }
  const { db, file } = await fixture();
  await db.write((orm) => orm.insert(tables.hosts).values({ alias: "example", data: "{}" }).run());
  inspect(file, (raw) => {
    expect(raw.prepare("PRAGMA journal_mode").get()?.["journal_mode"]).toBe("wal");
    const list = raw
      .prepare("PRAGMA table_list")
      .all()
      .filter((row) => row["schema"] === "main" && !String(row["name"]).startsWith("sqlite_"));
    expect(list).toHaveLength(Object.keys(tables).length + 1);
    for (const row of list) {
      expect(row["strict"]).toBe(1);
      if (String(row["name"]).startsWith("_")) continue;
      expect(
        raw
          .prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
          .all(row["name"] ?? null),
      ).toHaveLength(3);
    }
    expect(() => {
      raw.exec("INSERT INTO hosts VALUES ('bad', 'not json')");
    }).toThrow();
    expect(() => {
      raw.exec("INSERT INTO worktree_parents VALUES (x'1234', 'a')");
    }).toThrow();
    expect(() => {
      raw.exec("INSERT INTO sessions(id, kind, data) VALUES ('bad', 'invented', '{}')");
    }).toThrow();
  });
});

test("every foreign key rejects referenced-parent deletion, including host with saved sessions (#1152)", async () => {
  const { db, file } = await fixture();
  await db.write((orm) =>
    importRows(
      orm,
      sources([
        {
          ...session,
          orchestrator: {
            identity: "root",
            history: [],
            worktrees: [{ path: tree.path, identity: tree.identity, state: "used" }],
          },
        },
        { ...session, id: "child", parentId: "parent" },
        remote,
      ]),
    ),
  );
  inspect(file, (raw) => {
    let count = 0;
    for (const table of ["sessions", "worktrees", "owned_worktrees", "pending_removals"]) {
      for (const fk of raw.prepare(`PRAGMA foreign_key_list('${table}')`).all()) {
        expect(fk["on_delete"]).toBe("RESTRICT");
        const parent = String(fk["table"]);
        const from = String(fk["from"]);
        const to = String(fk["to"]);
        const row = raw
          .prepare(`SELECT "${from}" AS value FROM "${table}" WHERE "${from}" IS NOT NULL LIMIT 1`)
          .get();
        expect(row).toBeDefined();
        expect(() =>
          raw.prepare(`DELETE FROM "${parent}" WHERE "${to}" = ?`).run(row?.["value"] ?? null),
        ).toThrow(/FOREIGN KEY/);
        count++;
      }
    }
    expect(count).toBe(8);
  });
  expect(
    (await executeDataCommand(db, { type: "forget-host", host: "example" })).publicationPending,
  ).toBe(false);
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM hosts").all()).toEqual([]);
    expect(
      raw
        .prepare("SELECT id FROM sessions ORDER BY id")
        .all()
        .map((row) => row["id"]),
    ).toEqual(["child", "parent"]);
  });
  await expect(executeDataCommand(db, { type: "remove-session", id: "parent" })).rejects.toThrow();
  await executeDataCommand(db, { type: "remove-session", id: "child" });
  await executeDataCommand(db, { type: "remove-session", id: "parent" });
});

test("rollback removes data and change rows, the serialized queue survives failure, and pushes follow commit", async () => {
  const { db, file, publications } = await fixture();
  await db.retryPublication();
  const pushes = vi.fn(() => {
    const raw = new DatabaseSync(file);
    try {
      expect(raw.prepare("SELECT * FROM hosts").all()).toHaveLength(1);
    } finally {
      raw.close();
    }
  });
  const off = publications.subscribe(pushes);
  await expect(
    db.write((orm) => {
      orm.insert(tables.hosts).values({ alias: "rollback", data: "{}" }).run();
      throw new Error("crash");
    }),
  ).rejects.toThrow("crash");
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM hosts").all()).toEqual([]);
    expect(raw.prepare("SELECT * FROM _changes").all()).toEqual([]);
  });
  expect(pushes).not.toHaveBeenCalled();
  await Promise.all([
    executeDataCommand(db, {
      type: "register-host",
      host: { host: "example", codeFolder: "~/code" },
    }),
    db.write((orm) => orm.run(sql`UPDATE hosts SET data='{}' WHERE alias='example'`)),
  ]);
  expect(pushes).toHaveBeenCalledTimes(2);
  off();
});

test("failed publication retains its cursor and reports committed success without replaying the mutation", async () => {
  const { profile, db } = await fixture();
  await db.close();
  connections.pop();
  const publish = vi.fn().mockImplementationOnce(() => {
    throw new Error("reader down");
  });
  const pending = await ProfileDatabase.open(profile, { publish });
  connections.push(pending);
  expect(
    (
      await executeDataCommand(pending, {
        type: "register-host",
        host: { host: "example", codeFolder: "~/code" },
      })
    ).publicationPending,
  ).toBe(true);
  await pending.retryPublication();
  expect(publish).toHaveBeenCalledTimes(2);
  await pending.retryPublication();
  expect(publish).toHaveBeenCalledTimes(2);
});

test("clean importer keeps recovery originals, imports out-of-order children and reruns without writes", async () => {
  const { db, profile, file } = await fixture();
  const input = sources([{ ...session, id: "child", parentId: "parent" }, session, remote]);
  await put(profile, input);
  const first = await importLegacy(db, profile);
  expect(first.value.alreadyImported).toBe(false);
  expect(JSON.parse(first.value.report)).toMatchObject({ quarantined: 0, accepted: 9 });
  await writeFile(join(profile, "sessions.json"), "[]");
  const second = await importLegacy(db, profile);
  expect(second.value).toEqual({ ...first.value, alreadyImported: true });
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT id FROM sessions").all()).toHaveLength(3);
  });
  const recovery: unknown = JSON.parse(
    await readFile(join(profile, "data/recovery/hosts-worktrees-sessions-v1.json"), "utf8"),
  );
  expect(recovery).toEqual(input);
});

test("orphan rows are quarantined with fixed reports and no synthesized parent", async () => {
  const { db, profile, file } = await fixture();
  await put(
    profile,
    sources([
      { ...remote, placement: { kind: "remote", host: "forgotten" } },
      { ...session, id: "orphan", parentId: "missing" },
      { ...session, repository: join(repo, "missing") },
      session,
      session,
      { ...session, id: "bad", agent: "invalid" },
    ]),
  );
  const result = await importLegacy(db, profile);
  expect(JSON.parse(result.value.report)).toMatchObject({ quarantined: 5 });
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM sessions").all()).toHaveLength(1);
    expect(
      raw
        .prepare("SELECT reason FROM quarantine")
        .all()
        .map((row) => row["reason"])
        .sort(),
    ).toEqual(["conflict", "invalid", "relationship", "relationship", "relationship"]);
    expect(JSON.stringify(raw.prepare("SELECT * FROM quarantine").all())).not.toContain(
      "forgotten",
    );
  });
});

test("interrupted import rolls back its accepted rows, quarantine and trigger log and can be restarted", async () => {
  const { db, file, profile } = await fixture();
  await put(profile);
  await expect(
    db.write((orm) => {
      importRows(orm, sources());
      throw new Error("interrupted");
    }),
  ).rejects.toThrow("interrupted");
  inspect(file, (raw) => {
    for (const table of ["hosts", "sessions", "quarantine", "_changes", "_imports"])
      expect(raw.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  });
  expect((await importLegacy(db, profile)).value.alreadyImported).toBe(false);
});

test.each(["version", "digest", "strict", "trigger", "missing", "extra", "foreign-key"])(
  "startup refuses %s corruption rather than replacing data",
  async (kind) => {
    const { db, profile, file } = await fixture();
    await db.close();
    connections.pop();
    inspect(file, (raw) => {
      if (kind === "version") raw.exec("PRAGMA user_version=99");
      if (kind === "digest") raw.exec("UPDATE _schema SET digest='changed'");
      if (kind === "strict")
        raw.exec(
          "DROP TABLE worktree_parents; CREATE TABLE worktree_parents(path TEXT, identity TEXT)",
        );
      if (kind === "trigger") raw.exec("DROP TRIGGER hosts_update");
      if (kind === "missing") raw.exec("DROP TABLE worktree_parents");
      if (kind === "extra") raw.exec("CREATE TABLE extra(id INTEGER) STRICT");
      if (kind === "foreign-key")
        raw.exec(
          "PRAGMA foreign_keys=OFF; INSERT INTO worktrees VALUES ('orphan', 'missing', '{}')",
        );
    });
    await expect(ProfileDatabase.open(profile)).rejects.toThrow();
  },
);

test("migration failures are atomic and leave the original database intact", async () => {
  const { db, profile, file } = await fixture();
  await db.close();
  connections.pop();
  inspect(file, (raw) => {
    raw.exec("PRAGMA user_version=0");
  });
  await expect(ProfileDatabase.open(profile)).rejects.toThrow();
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM hosts").all()).toEqual([]);
  });
});

test("closed boundaries reject writes and async transaction bodies roll back", async () => {
  const { db } = await fixture();
  await expect(
    db.write(async (orm) => {
      orm.insert(tables.hosts).values({ alias: "bad", data: "{}" }).run();
      await Promise.resolve();
    }),
  ).rejects.toThrow("synchronous");
  await db.close();
  connections.pop();
  await expect(db.retryPublication()).rejects.toThrow("closed");
});

test("two subscribed readers see only committed database snapshots", async () => {
  const { db, file, publications } = await fixture();
  await db.retryPublication();
  const read = () => {
    const raw = new DatabaseSync(file);
    try {
      const hosts: unknown = raw
        .prepare("SELECT data FROM hosts")
        .all()
        .map((row): unknown => JSON.parse(String(row["data"])));
      if (!registeredHosts(hosts)) throw new Error("Invalid hosts");
      return { hosts, locations: [] };
    } finally {
      raw.close();
    }
  };
  const first = new ViewRegistry(publications, read);
  const second = new ViewRegistry(publications, read);
  const a = vi.fn<(value: ViewSnapshot) => void>();
  const b = vi.fn<(value: ViewSnapshot) => void>();
  try {
    first.subscribe({ id: "one", view: "hosts", params: {} }, a);
    second.subscribe({ id: "two", view: "hosts", params: {} }, b);
    await vi.waitFor(() => {
      expect(a).toHaveBeenCalledTimes(1);
    });
    first.acknowledge("one", 1, publications.revision);
    second.acknowledge("two", 1, publications.revision);
    await executeDataCommand(db, {
      type: "register-host",
      host: { host: "example", codeFolder: "~/code" },
    });
    await vi.waitFor(() => {
      expect(b).toHaveBeenCalledTimes(2);
    });
    expect(a.mock.lastCall?.[0].data).toEqual(b.mock.lastCall?.[0].data);
    expect(b.mock.lastCall?.[0].data).toEqual({
      hosts: [{ host: "example", codeFolder: "~/code" }],
      locations: [],
    });
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("legacy version mismatches and unsafe recovery sources fail without completion markers", async () => {
  const { db, profile, file } = await fixture();
  await put(profile, { ...sources(), "settings.json": '{"version":99}' });
  await expect(importLegacy(db, profile)).rejects.toThrow("version");
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM _imports").all()).toEqual([]);
  });
  const other = await fixture();
  await put(other.profile);
  const path = join(other.profile, "sessions.json");
  await rm(path);
  await symlink(join(other.profile, "settings.json"), path);
  await expect(importLegacy(other.db, other.profile)).rejects.toThrow();
  if (process.platform !== "win32") {
    const insecure = await fixture();
    await put(insecure.profile);
    await chmod(join(insecure.profile, "sessions.json"), 0o644);
    await expect(importLegacy(insecure.db, insecure.profile)).rejects.toThrow();
  }
});

test("Drizzle schema declarations match the deployed foreign keys and SQL constraints", async () => {
  const { getTableConfig } = await import("drizzle-orm/sqlite-core");
  const { file } = await fixture();
  inspect(file, (raw) => {
    for (const table of Object.values(tables)) {
      const config = getTableConfig(table);
      expect(
        raw
          .prepare(`PRAGMA table_info('${config.name}')`)
          .all()
          .map((row) => row["name"]),
      ).toEqual(config.columns.map((column) => column.name));
      const foreignKeys = raw.prepare(`PRAGMA foreign_key_list('${config.name}')`).all();
      expect(foreignKeys).toHaveLength(config.foreignKeys.length);
      for (const foreignKey of config.foreignKeys) {
        const reference = foreignKey.reference();
        expect(foreignKey.onDelete).toBe("restrict");
        expect(
          foreignKeys.some(
            (fk) =>
              fk["from"] === reference.columns[0]?.name &&
              fk["to"] === reference.foreignColumns[0]?.name,
          ),
        ).toBe(true);
      }
      const deployed = String(
        raw
          .prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?")
          .get(config.name)?.["sql"],
      );
      for (const check of config.checks) expect(deployed).toContain(check.name);
    }
  });
});

test("domain commands validate claims, keep ownership and remove only intended saved children", async () => {
  const { db, file } = await fixture();
  await executeDataCommand(db, {
    type: "register-repository",
    path: repo,
    registration: "12345678-1234-1234-1234-123456789abc",
  });
  await executeDataCommand(db, {
    type: "remember-worktree",
    worktree: {
      ...tree,
      directoryIdentity: "directory",
      review: { branch: "main", head: "a".repeat(40), refs: "refs", exclusions: "b".repeat(64) },
    },
  });
  const { readSessions } = await import("../../../../../src/main/workspace/session-store");
  for (const raw of [
    {
      ...session,
      orchestrator: {
        identity: "root",
        history: [],
        worktrees: [{ path: tree.path, identity: tree.identity, state: "unused" }],
      },
    },
    { ...session, id: "home", home: true, agent: "shell", worktree: repo, branch: null },
    { ...session, id: "config", config: true, worktree: repo, branch: null },
    { ...session, id: "external", worktree: join(repo, "external") },
  ]) {
    const parsed = readSessions([raw])[0];
    if (!parsed) throw new Error("Invalid fixture");
    await executeDataCommand(db, { type: "save-session", session: parsed });
  }
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM owned_worktrees").all()).toHaveLength(1);
  });
  await executeDataCommand(db, { type: "remove-session", id: "parent" });
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM owned_worktrees").all()).toEqual([]);
  });
  for (const command of [
    { type: "register-host", host: { host: "-bad", codeFolder: "~/code" } },
    { type: "register-repository", path: "relative" },
    { type: "register-repository", path: repo, registration: "bad" },
    { type: "register-repository", path: repo, registration: "-".repeat(36) },
    { type: "remember-worktree", worktree: { ...tree, identity: "" } },
    { type: "forget-host", host: "-bad" },
    { type: "remove-session", id: "" },
  ] satisfies DataCommand[])
    await expect(executeDataCommand(db, command)).rejects.toThrow();
});

test("session relationship validation rejects missing placement, wrong repository and forged ownership", async () => {
  const { db } = await fixture();
  const cases = [
    { ...remote, placement: undefined },
    { ...session, repository: join(repo, "another") },
    { ...session, parentId: "parent", id: "child", repository: join(repo, "another") },
    {
      ...session,
      id: "owner",
      orchestrator: {
        identity: "root",
        history: [],
        worktrees: [{ path: tree.path, identity: "wrong", state: "used" }],
      },
    },
    {
      ...session,
      id: "owner",
      orchestrator: {
        identity: "root",
        history: [],
        worktrees: [{ path: join(repo, "absent"), identity: "wrong", state: "used" }],
      },
    },
    { ...session, id: "invalid", agent: "unknown" },
  ];
  await db.write((orm) => importRows(orm, sources()));
  const { insertSession } = await import("../../../../../src/main/data/sqlite/commands");
  for (const input of cases)
    await expect(
      db.write((orm) => {
        insertSession(orm, input);
      }),
    ).rejects.toThrow();
});

test.each([
  ["settings.json", "{"],
  ["settings.json", JSON.stringify({ version: 2, settings: null })],
  ["settings.json", JSON.stringify({ version: 2, settings: { registeredHosts: {} } })],
  [
    "settings.json",
    JSON.stringify({ version: 2, settings: { registeredHosts: [{ host: "bad!" }] } }),
  ],
  ["worktrees.json", JSON.stringify({ version: 1, repositories: {}, managed: {} })],
  [
    "worktrees.json",
    JSON.stringify({
      version: 1,
      repositories: ["relative", repo, repo],
      managed: [null, { ...tree, repository: join(repo, "missing") }],
      registrations: [
        { path: "relative" },
        { path: join(repo, "missing"), id: "12345678-1234-1234-1234-123456789abc" },
      ],
      pendingRemovals: [null],
      parents: [null],
    }),
  ],
  [
    "worktrees.json",
    JSON.stringify({
      version: 1,
      repositories: [],
      managed: [],
      registrations: {},
      parents: {},
      pendingRemovals: {},
    }),
  ],
  ["sessions.json", "{}"],
  [
    "sessions.json",
    JSON.stringify([
      null,
      { ...session, id: "a", parentId: "b" },
      { ...session, id: "b", parentId: "a" },
    ]),
  ],
])("importer reports malformed and orphaned legacy data from %s", async (source, data) => {
  const { db } = await fixture();
  const result = await db.write((orm) => importRows(orm, { ...sources([]), [source]: data }));
  expect(result.value.quarantined).toBeGreaterThan(0);
});

test("missing legacy files import once, concurrent calls reuse the same recovery snapshot", async () => {
  const { db, profile } = await fixture();
  const results = await Promise.all([importLegacy(db, profile), importLegacy(db, profile)]);
  expect(results.map((result) => result.value.alreadyImported)).toEqual([false, true]);
  expect(JSON.parse(results[0].value.report)).toEqual({
    accepted: 0,
    quarantined: 0,
    sources: [],
  });
});

test("recovery corruption refuses instead of importing mutable JSON over frozen originals", async () => {
  const { db, profile } = await fixture();
  await put(profile);
  await importLegacy(db, profile);
  const recovery = join(profile, "data/recovery/hosts-worktrees-sessions-v1.json");
  await chmod(recovery, 0o600);
  await writeFile(recovery, "{}");
  await chmod(recovery, 0o400);
  await expect(importLegacy(db, profile)).rejects.toThrow("Invalid recovery snapshot");
  if (process.platform !== "win32") {
    await chmod(recovery, 0o600);
    await expect(importLegacy(db, profile)).rejects.toThrow("permissions");
  }
});

test("unknown legacy worktree version is actionable and records no completion", async () => {
  const { db, profile } = await fixture();
  await put(profile, { ...sources(), "worktrees.json": '{"version":42}' });
  await expect(importLegacy(db, profile)).rejects.toThrow("worktree version");
});

test("startup refuses foreign keys off before any schema inspection or migration", async () => {
  const profile = await mkdtemp(join(tmpdir(), "foom-fk-disabled-"));
  roots.push(profile);
  const original: unknown = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec")?.value;
  if (typeof original !== "function") throw new Error("Missing native exec implementation");
  const execution = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    statement,
  ) {
    Reflect.apply(original, this, [statement.replace("foreign_keys=ON", "foreign_keys=OFF")]);
  });
  try {
    await expect(ProfileDatabase.open(profile)).rejects.toThrow("foreign_keys=ON");
  } finally {
    execution.mockRestore();
  }
});

test("process death mid-import leaves no accepted rows or completion and recovery can resume", async () => {
  const { db, profile, file } = await fixture();
  await put(profile);
  await db.close();
  connections.pop();
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const { DatabaseSync } = require('node:sqlite');
    const { drizzle } = require('drizzle-orm/node-sqlite');
    const { sql } = require('drizzle-orm');
    const client = new DatabaseSync(process.argv[1]);
    client.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    drizzle({client}).run(sql.raw("INSERT INTO hosts VALUES ('interrupted', '{}')"));
    process.stdout.write('transaction-open', () => process.kill(process.pid, 'SIGKILL'));
  `,
      file,
    ],
    { encoding: "utf8" },
  );
  expect(child.error).toBeUndefined();
  expect(child.stdout).toBe("transaction-open");
  expect(child.status).not.toBe(0);
  inspect(file, (raw) => {
    for (const name of ["hosts", "_changes", "_imports"])
      expect(raw.prepare(`SELECT * FROM ${name}`).all()).toEqual([]);
  });
  const resumed = await ProfileDatabase.open(profile);
  connections.push(resumed);
  expect((await importLegacy(resumed, profile)).value.alreadyImported).toBe(false);
});

test("settings and consent domain writes publish only committed validated profile data", async () => {
  const { saveProfileSettings, saveAgentConsent } = await import(
    "../../../../../src/main/data/sqlite/settings"
  );
  const { db, file, publications } = await fixture();
  await db.retryPublication();
  const listener = vi.fn();
  const off = publications.subscribe(listener);
  try {
    await saveProfileSettings(db, {
      terminalClipboardWrites: true,
      wakeIntervalMinutes: 7,
      panelColor: "subtle",
    });
    await saveProfileSettings(db, { terminalClipboardWrites: false });
    await saveAgentConsent(db, "codex", true, "a".repeat(64));
    await saveAgentConsent(db, "codex", false, null);
    expect(listener).toHaveBeenCalledTimes(4);
    inspect(file, (raw) => {
      expect(
        raw
          .prepare("SELECT value FROM profile_settings WHERE key='terminalClipboardWrites'")
          .get()?.["value"],
      ).toBe("false");
      expect(raw.prepare("SELECT acknowledged,identity FROM agent_consents").get()).toEqual({
        acknowledged: 0,
        identity: null,
      });
      expect(() => {
        raw.exec("INSERT INTO profile_settings VALUES ('unknown','true')");
      }).toThrow();
      expect(() => {
        raw.exec("UPDATE profile_settings SET value='2' WHERE key='terminalClipboardWrites'");
      }).toThrow();
      expect(() => {
        raw.exec("UPDATE profile_settings SET value='null' WHERE key='panelColor'");
      }).toThrow();
      expect(() => {
        raw.exec("INSERT INTO agent_consents VALUES ('bad',2,NULL)");
      }).toThrow();
    });
    for (const input of [
      { terminalClipboardWrites: "yes" },
      { registeredHosts: [] },
      { agentBypassAcknowledged: {} },
      { agentBypassIdentities: {} },
      { unknown: true },
    ])
      await expect(saveProfileSettings(db, input)).rejects.toThrow();
    await expect(saveAgentConsent(db, "bad!", true, null)).rejects.toThrow();
    await expect(saveAgentConsent(db, "codex", true, "not-a-digest")).rejects.toThrow();
  } finally {
    off();
  }
});

test("settings import preserves accepted config baseline and historical consent without reading external config", async () => {
  const { createHash } = await import("node:crypto");
  const { importProfileSettings } = await import("../../../../../src/main/data/sqlite/settings");
  const { db, file, profile } = await fixture();
  const configText = JSON.stringify({ kind: "settings", hooks: false });
  await put(profile, {
    ...sources(),
    "settings.json": JSON.stringify({
      version: 2,
      remoteProfile: "a".repeat(32),
      configText,
      configDigest: createHash("sha256").update(configText).digest("hex"),
      themeDigests: { "themes/test.json": "b".repeat(64) },
      settings: {
        terminalClipboardWrites: true,
        agentArguments: { codex: [] },
        agentBypassAcknowledged: { codex: true, "custom-agent": true, claude: false },
        agentBypassIdentities: { claude: "c".repeat(64) },
      },
    }),
  });
  expect((await importProfileSettings(db, profile)).value.alreadyImported).toBe(false);
  expect((await importProfileSettings(db, profile)).value.alreadyImported).toBe(true);
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM profile_metadata").all()).toHaveLength(5);
    expect(
      raw.prepare("SELECT identity FROM agent_consents WHERE agent='custom-agent'").get()?.[
        "identity"
      ],
    ).toBeNull();
    expect(
      raw.prepare("SELECT identity FROM agent_consents WHERE agent='codex'").get()?.["identity"],
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(raw.prepare("SELECT * FROM quarantine").all()).toEqual([]);
  });
});

test("settings importer quarantines invalid consent, retired secrets and unapproved v2 config projections", async () => {
  const { importSettingsRows } = await import("../../../../../src/main/data/sqlite/settings");
  for (const input of [
    {
      version: 1,
      settings: {
        hooks: true,
        colorMode: "dark",
        agentBypassIdentities: { codex: "bad" },
        inference: { secret: "never-persist-me" },
      },
    },
    {
      version: 2,
      settings: { hooks: false },
      remoteProfile: "bad",
      configText: "{}",
      configDigest: "bad",
      themeDigests: { outside: "bad" },
    },
    { version: 2, settings: null },
  ]) {
    const { db, file } = await fixture();
    const result = await db.write((orm) => importSettingsRows(orm, JSON.stringify(input)));
    expect(result.value.quarantined).toBeGreaterThan(0);
    inspect(file, (raw) => {
      expect(JSON.stringify(raw.prepare("SELECT * FROM profile_settings").all())).not.toContain(
        "never-persist-me",
      );
    });
  }
  const { db } = await fixture();
  expect((await db.write((orm) => importSettingsRows(orm, null))).value.accepted).toBe(0);
  expect((await db.write((orm) => importSettingsRows(orm, "{"))).value.quarantined).toBe(1);
  await expect(db.write((orm) => importSettingsRows(orm, '{"version":99}'))).rejects.toThrow(
    "version",
  );
});

test("settings migration upgrades an existing first-group database without losing rows", async () => {
  const { db, file, profile } = await fixture();
  await executeDataCommand(db, {
    type: "register-host",
    host: { host: "example", codeFolder: "~/code" },
  });
  await db.close();
  connections.pop();
  const { getTableConfig } = await import("drizzle-orm/sqlite-core");
  inspect(file, (raw) => {
    const original = new Set([
      "hosts",
      "repositories",
      "worktrees",
      "sessions",
      "owned_worktrees",
      "pending_removals",
      "worktree_parents",
      "quarantine",
      "_changes",
      "_imports",
    ]);
    for (const table of Object.values(tables)) {
      const name = getTableConfig(table).name;
      if (!original.has(name)) raw.exec(`DROP TABLE "${name}"`);
    }
    raw.exec("DELETE FROM _schema WHERE version > 1; PRAGMA user_version=1");
  });
  const upgraded = await ProfileDatabase.open(profile);
  connections.push(upgraded);
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM hosts").all()).toHaveLength(1);
    expect(raw.prepare("SELECT * FROM profile_settings").all()).toEqual([]);
    expect(raw.prepare("PRAGMA user_version").get()?.["user_version"]).toBeGreaterThanOrEqual(2);
  });
});

function encryptedFixture() {
  const key = randomBytes(32);
  return {
    supported: vi.fn(() => true),
    available: vi.fn(() => true),
    encrypt: vi.fn((value: string) => {
      const iv = randomBytes(12);
      const encoder = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([encoder.update(value, "utf8"), encoder.final()]);
      return Buffer.concat([iv, encoder.getAuthTag(), bytes]);
    }),
    decrypt: vi.fn((value: Buffer) => {
      const decoder = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decoder.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decoder.update(value.subarray(28)), decoder.final()]).toString("utf8");
    }),
  };
}
test("environment uses ciphertext BLOBs, masked snapshots and FK-restricted scopes", async () => {
  const api = await import("../../../../../src/main/data/sqlite/environment");
  const { db, file } = await fixture();
  const cipher = encryptedFixture();
  await api.saveDatabaseEnvironment(db, cipher, {
    scope: "all",
    previous: null,
    name: "SECRET",
    value: "private-value-never-in-sqlite",
    secret: true,
  });
  await api.saveDatabaseEnvironment(db, cipher, {
    scope: "codex",
    previous: null,
    name: "PLAIN",
    value: "visible",
    secret: false,
  });
  await api.saveDatabaseEnvironment(db, cipher, {
    scope: "all",
    previous: "SECRET",
    name: "SECRET",
    value: null,
    secret: true,
  });
  expect(cipher.encrypt).toHaveBeenCalledTimes(1);
  cipher.available.mockImplementation(() => false);
  const state = await api.readDatabaseEnvironment(db, cipher);
  expect(state.lists["all"]).toEqual([{ name: "SECRET", value: null, secret: true }]);
  expect(cipher.available).toHaveBeenCalledTimes(1);
  inspect(file, (raw) => {
    const secret = raw
      .prepare(
        "SELECT value,cipher,typeof(cipher) AS type FROM environment_entries WHERE name='SECRET'",
      )
      .get();
    expect(secret?.["value"]).toBeNull();
    expect(secret?.["type"]).toBe("blob");
    expect(
      Buffer.from(secret?.["cipher"] instanceof Uint8Array ? secret["cipher"] : []).includes(
        Buffer.from("private-value-never-in-sqlite"),
      ),
    ).toBe(false);
    expect(() => {
      raw.exec("DELETE FROM environment_scopes WHERE scope='all'");
    }).toThrow(/FOREIGN KEY/);
    expect(() => {
      raw.exec("UPDATE environment_entries SET value='leak' WHERE secret=1");
    }).toThrow();
  });
  await api.removeDatabaseEnvironment(db, "codex", "PLAIN");
  await expect(api.removeDatabaseEnvironment(db, "all", "NODE_OPTIONS")).rejects.toThrow();
  await api.removeDatabaseEnvironmentScope(db, "all");
  expect((await api.readDatabaseEnvironment(db, cipher)).lists["all"]).toEqual([]);
});
test("environment importer keeps verified ciphertext and fails atomically when keychain is locked", async () => {
  const api = await import("../../../../../src/main/data/sqlite/environment");
  const { db, profile, file } = await fixture();
  const cipher = encryptedFixture();
  const encoded = cipher.encrypt("kept-secret").toString("base64");
  await writeFile(
    join(profile, "environment.json"),
    JSON.stringify({
      version: 1,
      lists: {
        all: [
          { name: "SECRET", secret: true, cipher: encoded },
          {
            name: "OTHER",
            secret: true,
            cipher: cipher.encrypt("other-secret").toString("base64"),
          },
        ],
        codex: [{ name: "PLAIN", value: "plain" }],
      },
    }),
    { mode: 0o600 },
  );
  cipher.available.mockImplementation(() => false);
  await expect(api.importDatabaseEnvironment(db, profile, cipher)).rejects.toThrow("keychain");
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM environment_entries").all()).toEqual([]);
  });
  cipher.available.mockImplementation(() => true);
  cipher.available.mockClear();
  const result = await api.importDatabaseEnvironment(db, profile, cipher);
  expect(JSON.parse(result.value.report)).toEqual({ accepted: 3, quarantined: 0 });
  expect(cipher.available).toHaveBeenCalledTimes(1);
  expect((await api.importDatabaseEnvironment(db, profile, cipher)).value.alreadyImported).toBe(
    true,
  );
  inspect(file, (raw) => {
    const row = raw.prepare("SELECT cipher FROM environment_entries WHERE name='SECRET'").get();
    expect(
      Buffer.from(row?.["cipher"] instanceof Uint8Array ? row["cipher"] : []).toString("base64"),
    ).toBe(encoded);
    expect(JSON.stringify(raw.prepare("SELECT * FROM _changes").all())).not.toContain(
      "kept-secret",
    );
  });
});
test("environment commands validate scope, capacity, retained secrets and automatic URL credential encryption", async () => {
  const api = await import("../../../../../src/main/data/sqlite/environment");
  const { db } = await fixture();
  const cipher = encryptedFixture();
  const change = {
    scope: "all",
    previous: null,
    name: "HTTP_PROXY",
    value: "https://user:pass@proxy.test",
    secret: false,
  };
  await api.saveDatabaseEnvironment(db, cipher, change);
  expect((await api.readDatabaseEnvironment(db, cipher)).lists["all"][0]?.secret).toBe(true);
  await api.saveDatabaseEnvironment(db, cipher, {
    ...change,
    previous: "HTTP_PROXY",
    name: "RENAMED",
    value: null,
    secret: true,
  });
  for (const input of [
    { ...change, scope: "invalid!" },
    { ...change, name: "NODE_OPTIONS", value: "unsafe" },
    { ...change, previous: "missing" },
    { ...change, name: "RENAMED" },
    { ...change, value: null, secret: true },
    { ...change, previous: "RENAMED", value: null, secret: false },
  ])
    await expect(api.saveDatabaseEnvironment(db, cipher, input)).rejects.toThrow();
  cipher.available.mockImplementation(() => false);
  await expect(api.saveDatabaseEnvironment(db, cipher, { ...change, name: "NEW" })).rejects.toThrow(
    "keychain",
  );
  cipher.available.mockImplementation(() => true);
  await db.write((orm) => {
    orm.insert(tables.environmentScopes).values({ scope: "full" }).run();
    for (let index = 0; index < 64; index++)
      orm
        .insert(tables.environmentEntries)
        .values({
          scope: "full",
          name: `VAR_${String(index)}`,
          fold: `VAR_${String(index)}`,
          secret: 0,
          value: "v",
          cipher: null,
        })
        .run();
  });
  await expect(
    api.saveDatabaseEnvironment(db, cipher, {
      ...change,
      scope: "full",
      name: "NEW",
      value: "v",
      secret: false,
    }),
  ).rejects.toThrow("capacity");
  await expect(api.removeDatabaseEnvironmentScope(db, "bad!")).rejects.toThrow();
});
test("environment import quarantines malformed plaintext, bad ciphertext and case-fold collisions", async () => {
  const { importEnvironmentRows } = await import("../../../../../src/main/data/sqlite/environment");
  const { db } = await fixture();
  const cipher = encryptedFixture();
  const input = JSON.stringify({
    version: 1,
    lists: {
      all: [
        { name: "Name", value: "one" },
        { name: "NAME", value: "two" },
        { name: "NODE_OPTIONS", value: "bad" },
        { name: "HTTP_PROXY", value: "https://user:pass@proxy.test" },
        { name: "SECRET", secret: true, cipher: "not base64" },
        { name: "SECRET", secret: true, cipher: "AA==" },
        { name: "NO_VALUE" },
        null,
      ],
      "bad!": [],
      codex: {},
    },
  });
  const result = await db.write((orm) => importEnvironmentRows(orm, input, cipher, true));
  expect(result.value).toEqual({ accepted: 1, quarantined: 9 });
  expect(
    (await db.write((orm) => importEnvironmentRows(orm, null, cipher, false))).value.accepted,
  ).toBe(0);
  expect(
    (await db.write((orm) => importEnvironmentRows(orm, "{", cipher, false))).value.quarantined,
  ).toBe(1);
  expect(
    (
      await db.write((orm) =>
        importEnvironmentRows(orm, '{"version":1,"lists":null}', cipher, false),
      )
    ).value.quarantined,
  ).toBe(1);
  await expect(
    db.write((orm) => importEnvironmentRows(orm, '{"version":2}', cipher, false)),
  ).rejects.toThrow("version");
});
