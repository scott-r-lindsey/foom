import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  rm,
  writeFile,
  chmod,
  readFile,
  readdir,
  symlink,
  mkdir,
  rename,
} from "node:fs/promises";
import * as privateFiles from "../../../../../src/node-common/private-files";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { ProfileDatabase, assertForeignKeys } from "../../../../../src/main/data/sqlite/database";
import type { DataCommand } from "../../../../../src/main/data-import/commands";
import { executeDataCommand } from "../../../../../src/main/data-import/commands";
import {
  importLegacyGroup,
  importLegacy,
  importRows,
} from "../../../../../src/main/data-import/importer";
import { ViewChanges } from "../../../../../src/main/data/view-changes";
import { ViewRegistry } from "../../../../../src/main/data/view-registry";
import { object } from "../../../../../src/shared/control-validation";
import { registeredHosts } from "../../../../../src/shared/registered-hosts";
import type { ViewSnapshot } from "../../../../../src/shared/data-views";
import * as tables from "../../../../../src/main/data/sqlite/schema";

vi.mock("electron", () => {
  const cipher = encryptedFixture();
  return {
    safeStorage: {
      getSelectedStorageBackend: () => "gnome_libsecret",
      isEncryptionAvailable: cipher.available,
      encryptString: cipher.encrypt,
      decryptString: cipher.decrypt,
    },
  };
});
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
  const { safeStorage } = await import("electron");
  const envelope = object(
    JSON.parse(
      await readFile(join(profile, "data/recovery/hosts-worktrees-sessions-v1.json"), "utf8"),
    ),
  );
  const recovery: unknown = JSON.parse(
    safeStorage.decryptString(Buffer.from(String(envelope["cipher"]), "base64")),
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
      expect(foreignKeys).toHaveLength(
        config.foreignKeys.reduce(
          (count, foreignKey) => count + foreignKey.reference().columns.length,
          0,
        ),
      );
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
  const { insertSession } = await import("../../../../../src/main/data-import/commands");
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
  await db.write((orm) => {
    orm.delete(tables.imports).run();
  });
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
    "../../../../../src/main/data-import/settings"
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
  const { importProfileSettings } = await import("../../../../../src/main/data-import/settings");
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

test.each([
  JSON.stringify({
    kind: "settings",
    sound: {
      soundscape: { token: "baseline-secret-marker" },
      working: true,
      alerts: true,
      workingVolume: 0.5,
      alertVolume: 0.5,
    },
  }),
  '{"kind":"settings","hooks":{"token":"baseline-secret-marker"},"hooks":false}',
])(
  "settings baseline import stores only the validated projection with a matching restart digest (%s)",
  async (configText) => {
    const { importSettingsRows } = await import("../../../../../src/main/data-import/settings");
    const { parseSettingsFile } = await import("../../../../../src/shared/config-files");
    const { db, file } = await fixture();
    const configDigest = createHash("sha256").update(configText).digest("hex");
    const result = await db.write((orm) =>
      importSettingsRows(
        orm,
        JSON.stringify({
          version: 2,
          settings: {},
          configText,
          configDigest,
        }),
      ),
    );
    expect(result.value).toEqual({ accepted: 3, quarantined: 0 });
    inspect(file, (raw) => {
      const metadata = Object.fromEntries<unknown>(
        raw
          .prepare("SELECT key,value FROM profile_metadata")
          .all()
          .map((row) => [String(row["key"]), row["value"]]),
      );
      expect(metadata["configText"]).toBe(
        JSON.stringify(JSON.stringify({ kind: "settings", ...parseSettingsFile(configText) })),
      );
      const baseline = JSON.stringify({ kind: "settings", ...parseSettingsFile(configText) });
      expect(metadata["configDigest"]).toBe(
        JSON.stringify(createHash("sha256").update(baseline).digest("hex")),
      );
      expect(metadata["configDigest"]).not.toBe(JSON.stringify(configDigest));
      expect(JSON.stringify(metadata)).not.toContain("baseline-secret-marker");
    });
    // Unknown content must not reach the database or its write-ahead journal.
    for (const name of [file, `${file}-wal`])
      expect((await readFile(name)).includes(Buffer.from("baseline-secret-marker"))).toBe(false);
  },
);

test("settings import quarantines a 65,530-byte baseline expanded beyond the restart limit", async () => {
  const { importProfileSettings } = await import("../../../../../src/main/data-import/settings");
  const { parseSettingsFile } = await import("../../../../../src/shared/config-files");
  const { db, file, profile } = await fixture();
  const args = [...Array.from({ length: 15 }, () => "x".repeat(4096)), "x"];
  const source = () =>
    JSON.stringify({
      kind: "settings",
      agents: { "custom-agent": true },
      agentArguments: { "custom-agent": args },
      sound: {
        soundscape: "default",
        working: true,
        alerts: true,
        workingVolume: 0.5,
        alertVolume: 0.5,
      },
    });
  args[15] = "x".repeat(65530 - Buffer.byteLength(source()) + 1);
  const configText = source();
  expect(Buffer.byteLength(configText)).toBe(65530);
  const projection = parseSettingsFile(configText);
  expect(projection.agents).toEqual({ "custom-agent": true });
  expect(projection.agentArguments).toEqual({ "custom-agent": args });
  const normalized = JSON.stringify({ kind: "settings", ...projection });
  expect(Buffer.byteLength(normalized)).toBeGreaterThan(65536);
  expect(() => parseSettingsFile(normalized)).toThrow();
  const original = JSON.stringify({
    version: 2,
    settings: {},
    configText,
    configDigest: createHash("sha256").update(configText).digest("hex"),
  });
  await writeFile(join(profile, "settings.json"), original, { mode: 0o600 });
  const result = await importProfileSettings(db, profile);
  expect(JSON.parse(result.value.report)).toEqual({ accepted: 1, quarantined: 1 });
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM profile_metadata").all()).toEqual([
      expect.objectContaining({ key: "configVersion", value: "2" }),
    ]);
    expect(raw.prepare("SELECT source,position,reason FROM quarantine").all()).toEqual([
      { source: "settings.json#configBaseline", position: -1, reason: "invalid" },
    ]);
  });
  expect(await readFile(join(profile, "settings.json"), "utf8")).toBe(original);
  const { safeStorage } = await import("electron");
  const envelope = object(
    JSON.parse(await readFile(join(profile, "data/recovery/settings-consents-v1.json"), "utf8")),
  );
  expect(
    JSON.parse(safeStorage.decryptString(Buffer.from(String(envelope["cipher"]), "base64"))),
  ).toEqual({ "settings.json": original });
});

test("settings importer quarantines invalid consent, retired secrets and unapproved v2 config projections", async () => {
  const { importSettingsRows } = await import("../../../../../src/main/data-import/settings");
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
    for (const table of Object.values(tables).reverse()) {
      const name = getTableConfig(table).name;
      if (!original.has(name)) raw.exec(`DROP TABLE "${name}"`);
    }
    raw.exec(
      "DROP INDEX IF EXISTS repositories_registration_identity; DELETE FROM _schema WHERE version > 1; PRAGMA user_version=1",
    );
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
  const api = await import("../../../../../src/main/data-import/environment");
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
  const api = await import("../../../../../src/main/data-import/environment");
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
  const api = await import("../../../../../src/main/data-import/environment");
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
  const { importEnvironmentRows } = await import("../../../../../src/main/data-import/environment");
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
        {
          name: "SECRET",
          secret: true,
          cipher: cipher.encrypt("invalid\0value").toString("base64"),
        },
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

const historyTime = new Date().toISOString();
const operationId = "11111111-1111-4111-8111-111111111111";
const actor = {
  grantedAt: historyTime,
  generation: "generation-1",
  sessionId: "session-1",
  repository: repo,
  worktree: tree.path,
  terminalId: "parent",
  parentId: null,
  role: "orchestrator",
};
const storedOperation = {
  actor,
  key: "a".repeat(64),
  fingerprint: "b".repeat(64),
  operation: {
    operationId,
    action: "prompt",
    targetId: "child",
    resultId: null,
    status: "running",
    createdAt: historyTime,
    updatedAt: historyTime,
    reason: "intent",
    inputHash: "c".repeat(64),
  },
};
const boardThread = {
  id: "thread-1",
  repository: createHash("sha256").update(repo).digest("hex"),
  to: [createHash("sha256").update(repo).digest("hex")],
  title: "Topic",
  state: "open",
  createdAt: historyTime,
  updatedAt: historyTime,
};
const boardPost = {
  id: "post-1",
  thread: "thread-1",
  author: "human",
  kind: "fyi",
  text: "Board message",
  links: ["#1162"],
  timestamp: historyTime,
};
const boardReceipt = {
  scope: "human",
  key: "key-1",
  hash: "d".repeat(64),
  result: { thread: "thread-1", post: "post-1" },
};
const verdictRecord = {
  type: "verdict",
  id: "verdict-1",
  terminalId: "parent",
  timestamp: historyTime,
  verdict: {
    state: "done",
    reason: "exit",
    signal: "process",
    confidence: 1,
    attentionKind: "unknown",
  },
};
const verdictFeedback = {
  type: "action",
  terminalId: "parent",
  verdictId: "verdict-1",
  action: "replied",
  timestamp: historyTime,
};
function controlSources() {
  const remotePath = "/code/.foom-worktree-child";
  const remoteTree = {
    repository: "/repo",
    path: `/foom-remote/${createHash("sha256")
      .update(JSON.stringify(["example", remotePath]))
      .digest("hex")}`,
    identity: "remote-identity",
    branch: "topic",
    remoteCheckout: {
      host: "example",
      codeFolder: "/code",
      repository: "/code/repo",
      path: remotePath,
      origin: "git@example.test:repo.git",
    },
  };
  const localForge = {
    ...tree,
    branch: "topic",
    number: 1,
    prBranch: "topic",
    binding: "source",
    remote: "https://example.test/repo.git",
    orchestrator: false,
    pr: { number: 1, headSha: "f".repeat(40), state: "OPEN", requiredChecks: "success" },
  };
  return {
    "control/board.json": JSON.stringify({
      version: 1,
      threads: [boardThread],
      posts: [boardPost],
      receipts: [boardReceipt],
    }),
    "control/forge.json": JSON.stringify({ version: 1, entries: [localForge, remoteTree] }),
    [`control/operation-${operationId}.json`]: JSON.stringify({
      ...storedOperation,
      token: "forbidden-token",
      prompt: "forbidden-prompt",
    }),
    "control/actions-0.jsonl":
      JSON.stringify({
        ...storedOperation.operation,
        timestamp: historyTime,
        actor,
        tail: "forbidden-screen",
        token: "forbidden-token",
      }) + "\n",
    "agent-setup/offers.json": JSON.stringify(["codex", "custom-agent"]),
    "probe-notices/seen.json": JSON.stringify(["codex"]),
    "verdicts.jsonl": [verdictRecord, verdictFeedback].map((row) => JSON.stringify(row)).join("\n"),
    "codex-hook-health.json": JSON.stringify({ state: "trusted", fingerprint: "a".repeat(64) }),
    "foom-observers-1000/codex-health.json": JSON.stringify({
      state: "outdated",
      fingerprint: "b".repeat(64),
    }),
    "terminal-host-diagnostics/exits.json": JSON.stringify({
      version: 3,
      exits: [
        JSON.stringify({
          time: historyTime,
          reason: "fixture-exit",
          serviceName: "utility",
          pid: 1,
          exitCode: 0,
          stderr: "forbidden-stderr",
          cause: "host-exit",
          snapshot: { liveTerminals: 1, hostMemoryKB: null, lastMessageAgeMs: 1, mainLagMs: 1 },
          gone: { type: "Utility", reason: "crashed", exitCode: 1 },
        }),
      ],
      timeouts: [JSON.stringify({ time: historyTime, command: "ping", elapsedMs: 1 })],
      nearMisses: [
        JSON.stringify({
          time: historyTime,
          kind: "late-reply",
          replyLatencyMs: 1,
          probeElapsedMs: 1,
          lateCycles: 1,
          mainLagMs: 1,
        }),
      ],
    }),
  };
}
async function populatedControl() {
  const fixtureState = await fixture();
  const { importControlRows } = await import("../../../../../src/main/data-import/control");
  const input = controlSources();
  await fixtureState.db.write((orm) => importRows(orm, sources()));
  const result = await fixtureState.db.write((orm) => importControlRows(orm, input));
  return { ...fixtureState, input, report: result.value };
}
test("control imports typed board/forge/operation/audit/history without credentials or replay", async () => {
  const { file, report } = await populatedControl();
  expect(report.quarantined).toBe(0);
  inspect(file, (raw) => {
    for (const [name, count] of [
      ["board_threads", 1],
      ["board_posts", 1],
      ["board_recipients", 1],
      ["board_bindings", 1],
      ["board_receipts", 1],
      ["forge_observations", 2],
      ["offers", 3],
      ["agent_health", 2],
      ["control_operations", 1],
      ["audit_records", 2],
      ["operation_audit_links", 2],
      ["verdict_records", 1],
      ["verdict_actions", 1],
      ["terminal_diagnostics", 3],
    ] as const)
      expect(raw.prepare(`SELECT * FROM ${name}`).all()).toHaveLength(count);
    expect(raw.prepare("SELECT status,recovered FROM control_operations").get()).toEqual({
      status: "indeterminate",
      recovered: 1,
    });
    for (const name of ["control_operations", "audit_records", "terminal_diagnostics"])
      expect(JSON.stringify(raw.prepare(`SELECT * FROM ${name}`).all())).not.toMatch(
        /forbidden-token|forbidden-prompt|forbidden-screen|forbidden-stderr/,
      );
  });
});
test("every new control/board/history FK rejects referenced deletes, including composite relations", async () => {
  const { file } = await populatedControl();
  const { getTableConfig } = await import("drizzle-orm/sqlite-core");
  const selected = [
    tables.boardPosts,
    tables.boardRecipients,
    tables.boardBindings,
    tables.boardReceipts,
    tables.forgeObservations,
    tables.operationAuditLinks,
    tables.verdictActions,
  ];
  inspect(file, (raw) => {
    let checked = 0;
    for (const table of selected) {
      const name = getTableConfig(table).name;
      const keys = raw.prepare(`PRAGMA foreign_key_list('${name}')`).all();
      for (const id of new Set(keys.map((row) => row["id"]))) {
        const parts = keys.filter((row) => row["id"] === id);
        const first = parts[0];
        if (!first) throw new Error("Missing FK");
        const parent = String(first["table"]);
        const child = raw
          .prepare(
            `SELECT * FROM "${name}" WHERE ${parts.map((row) => `"${String(row["from"])}" IS NOT NULL`).join(" AND ")} LIMIT 1`,
          )
          .get();
        expect(child).toBeDefined();
        expect(() =>
          raw
            .prepare(
              `DELETE FROM "${parent}" WHERE ${parts.map((row) => `"${String(row["to"])}" = ?`).join(" AND ")}`,
            )
            .run(...parts.map((row) => child?.[String(row["from"])] ?? null)),
        ).toThrow(/FOREIGN KEY/);
        checked++;
      }
    }
    expect(checked).toBe(
      selected.reduce((count, table) => count + getTableConfig(table).foreignKeys.length, 0),
    );
  });
});
test("board domain append/resolve/retention is atomic and keeps post text out of audit", async () => {
  const api = await import("../../../../../src/main/data-import/board");
  const { db, file } = await fixture();
  await db.write((orm) => importRows(orm, sources()));
  await api.saveDatabaseBoardThread(db, boardThread);
  await api.appendDatabaseBoardPost(db, boardPost, boardReceipt);
  await api.resolveDatabaseBoardThread(db, "thread-1");
  await expect(api.appendDatabaseBoardPost(db, { ...boardPost, id: "post-late" })).rejects.toThrow(
    "resolved",
  );
  await expect(api.resolveDatabaseBoardThread(db, "missing")).rejects.toThrow();
  await expect(
    api.appendDatabaseBoardPost(db, { ...boardPost, thread: "missing" }),
  ).rejects.toThrow();
  const now = Date.parse(historyTime) + 31 * 24 * 60 * 60 * 1000;
  await api.saveDatabaseBoardThread(db, {
    ...boardThread,
    id: "child-thread",
    state: "resolved",
    child: { id: "child", worktreeId: "worktree", removedAt: historyTime },
  });
  await api.appendDatabaseBoardPost(db, {
    ...boardPost,
    id: "child-post",
    thread: "child-thread",
    author: "orchestrator:repo",
  });
  await api.pruneDatabaseBoard(db, now);
  await api.pruneDatabaseBoard(db, now);
  await expect(api.pruneDatabaseBoard(db, -1)).rejects.toThrow();
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT id FROM board_threads").all()).toEqual([{ id: "thread-1" }]);
    expect(raw.prepare("SELECT * FROM audit_records").all()).toEqual([]);
  });
});
test("operation intent is durable and deduplicated; audit clearing preserves operation state", async () => {
  const api = await import("../../../../../src/main/data-import/control");
  const { db, file } = await fixture();
  expect((await api.reserveDatabaseOperation(db, storedOperation)).value.created).toBe(true);
  expect((await api.reserveDatabaseOperation(db, storedOperation)).value.created).toBe(false);
  await expect(
    api.reserveDatabaseOperation(db, { ...storedOperation, fingerprint: "f".repeat(64) }),
  ).rejects.toThrow("conflict");
  await expect(
    api.reserveDatabaseOperation(db, {
      ...storedOperation,
      operation: { ...storedOperation.operation, status: "succeeded" },
    }),
  ).rejects.toThrow("Intent");
  await api.finishDatabaseOperation(db, operationId, "succeeded", "completed");
  await expect(api.finishDatabaseOperation(db, operationId, "running", "intent")).rejects.toThrow(
    "already finished",
  );
  inspect(file, (raw) => {
    const row = raw.prepare("SELECT data FROM control_operations").get();
    if (typeof row?.["data"] !== "string") throw new Error("Missing operation");
    expect(JSON.parse(row["data"])).toMatchObject({
      createdAt: storedOperation.operation.createdAt,
      status: "succeeded",
    });
  });
  await api.appendDatabaseAudit(db, {
    ...storedOperation.operation,
    actor,
    timestamp: historyTime,
  });
  await api.clearDatabaseAudit(db);
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM control_operations").all()).toHaveLength(1);
    expect(raw.prepare("SELECT * FROM audit_records").all()).toEqual([]);
  });
  await expect(
    api.finishDatabaseOperation(db, operationId, "invalid", "completed"),
  ).rejects.toThrow();
  await expect(api.finishDatabaseOperation(db, "missing", "failed", "error")).rejects.toThrow();
  await api.retireDatabaseOperation(db, operationId);
  await expect(
    api.reserveDatabaseOperation(db, { ...storedOperation, key: "bad" }),
  ).rejects.toThrow();
  const recovered = await populatedControl();
  await expect(api.reserveDatabaseOperation(recovered.db, storedOperation)).rejects.toThrow(
    "conflict",
  );
  await expect(
    api.finishDatabaseOperation(recovered.db, operationId, "failed", "error"),
  ).rejects.toThrow("live operation");
});
test("forge, offer, setup and verdict domain functions preserve owner validations", async () => {
  const api = await import("../../../../../src/main/data-import/control");
  const { db, file } = await fixture();
  await db.write((orm) => importRows(orm, sources()));
  const input = controlSources();
  const forgeData: unknown = JSON.parse(input["control/forge.json"]);
  const forgeRows = object(forgeData)["entries"];
  if (!Array.isArray(forgeRows)) throw new Error("Invalid fixture");
  await api.saveDatabaseForgeObservation(db, forgeRows[0]);
  for (const invalid of [
    { ...tree, branch: "bad branch" },
    { ...tree, branch: "main", pr: {} },
    { ...tree, branch: "main", remote: "https://user:pass@example.test/repo" },
    { ...tree, branch: "main", prBranch: "bad branch" },
    { ...tree, branch: "main", orchestrator: "yes" },
  ])
    await expect(api.saveDatabaseForgeObservation(db, invalid)).rejects.toThrow();
  await api.answerDatabaseOffer(db, "setup", "codex", true);
  await api.answerDatabaseOffer(db, "setup", "codex", false);
  await expect(api.answerDatabaseOffer(db, "setup", "bad!", true)).rejects.toThrow();
  await api.saveDatabaseVerdict(db, verdictRecord);
  await api.feedbackDatabaseVerdict(db, verdictFeedback);
  await expect(api.feedbackDatabaseVerdict(db, verdictFeedback)).rejects.toThrow();
  await expect(
    api.feedbackDatabaseVerdict(db, { ...verdictFeedback, verdictId: "missing" }),
  ).rejects.toThrow();
  await api.forgetDatabaseVerdict(db, "verdict-1");
  await expect(
    api.saveDatabaseVerdict(db, {
      ...verdictRecord,
      verdict: { ...verdictRecord.verdict, attentionKind: "invalid" },
    }),
  ).rejects.toThrow();
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM verdict_records").all()).toEqual([]);
  });
});

test("control importer is frozen, resumable and a no-op without rescanning changed production files", async () => {
  const { importDatabaseControl } = await import("../../../../../src/main/data-import/control");
  const { db, profile, file } = await fixture();
  await db.write((orm) => importRows(orm, sources()));
  for (const [name, contents] of Object.entries(controlSources())) {
    const directory = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
    if (directory) await mkdir(join(profile, directory), { recursive: true, mode: 0o700 });
    await writeFile(join(profile, name), contents, { mode: 0o600 });
  }
  const result = await importDatabaseControl(db, profile);
  expect(object(JSON.parse(result.value.report))["quarantined"]).toBe(0);
  await rm(join(profile, "control"), { recursive: true, force: true });
  expect((await importDatabaseControl(db, profile)).value.alreadyImported).toBe(true);
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM control_operations").all()).toHaveLength(1);
  });
});
test("dynamic source recovery uses the frozen manifest after a crash, and SQL interruptions abort", async () => {
  const { importLegacyGroup } = await import("../../../../../src/main/data-import/importer");
  const { LegacyBatch } = await import("../../../../../src/main/data-import/legacy-batch");
  const { db, profile, file } = await fixture();
  await writeFile(join(profile, "base.json"), "{}", { mode: 0o600 });
  await writeFile(join(profile, "extra.json"), "old", { mode: 0o600 });
  const discover = vi.fn(() => Promise.resolve(["base.json", "extra.json"]));
  await expect(
    importLegacyGroup(
      db,
      profile,
      "dynamic-fixture",
      discover,
      (orm) => {
        const batch = new LegacyBatch(orm);
        batch.row(
          "base",
          0,
          () => "example",
          (alias) => {
            orm.insert(tables.hosts).values({ alias, data: "{}" }).run();
            throw new Error("interrupted");
          },
        );
      },
      ["base.json"],
    ),
  ).rejects.toThrow("interrupted");
  await rm(join(profile, "extra.json"));
  discover.mockImplementation(() => Promise.resolve(["base.json"]));
  const value = await importLegacyGroup(
    db,
    profile,
    "dynamic-fixture",
    discover,
    (_orm, input) => input,
    ["base.json"],
  );
  expect(JSON.parse(value.value.report)).toMatchObject({ "extra.json": "old" });
  await importLegacyGroup(db, profile, "dynamic-fixture", discover, () => ({}), ["base.json"]);
  expect(discover).toHaveBeenCalledTimes(1);
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM hosts").all()).toEqual([]);
  });
});
test("control quarantine isolates orphan references, duplicates, malformed metadata and unknown fields", async () => {
  const { importControlRows } = await import("../../../../../src/main/data-import/control");
  const { db, file } = await fixture();
  await db.write((orm) => importRows(orm, sources()));
  const input = controlSources();
  const result = await db.write((orm) =>
    importControlRows(orm, {
      ...input,
      "control/board.json": JSON.stringify({
        version: 1,
        threads: [boardThread, boardThread, { ...boardThread, id: "bad", state: "invalid" }],
        posts: [boardPost, { ...boardPost, id: "orphan", thread: "missing" }],
        receipts: [
          boardReceipt,
          { ...boardReceipt, key: "orphan", result: { thread: "missing", post: null } },
        ],
      }),
      "control/forge.json": JSON.stringify({
        version: 1,
        entries: [
          { ...tree, branch: "main", repository: join(repo, "missing") },
          { ...tree, branch: "main", number: 0 },
        ],
      }),
      "agent-setup/offers.json": JSON.stringify(["bad!", "codex", "codex"]),
      "probe-notices/seen.json": "{}",
      "verdicts.jsonl": [
        JSON.stringify({
          ...verdictRecord,
          id: "invalid",
          verdict: { ...verdictRecord.verdict, confidence: 2 },
        }),
        JSON.stringify({ ...verdictFeedback, verdictId: "missing" }),
        "{",
      ].join("\n"),
      "codex-hook-health.json": JSON.stringify({ state: "invalid", fingerprint: "bad" }),
      "terminal-host-diagnostics/exits.json": JSON.stringify({
        version: 3,
        exits: ["{"],
        timeouts: {},
        nearMisses: [JSON.stringify({ time: historyTime, kind: "invalid" })],
      }),
    }),
  );
  expect(result.value.quarantined).toBeGreaterThan(10);
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM board_threads").all()).toHaveLength(1);
  });
});
test("legacy metadata parsers refuse incompatible versions and malformed file envelopes", async () => {
  const { importControlRows } = await import("../../../../../src/main/data-import/control");
  const { db } = await fixture();
  for (const input of [
    { "control/board.json": '{"version":1,"threads":{},"posts":{},"receipts":{}}' },
    {
      "control/forge.json": "{}",
    },
    { "control/forge.json": "{", "agent-setup/offers.json": "{" },
    { "control/forge.json": "[]", "terminal-host-diagnostics/exits.json": "[]" },
  ])
    await db.write((orm) => importControlRows(orm, input));
  await expect(
    db.write((orm) => importControlRows(orm, { "control/board.json": '{"version":99}' })),
  ).rejects.toThrow("version");
});
test("forgotten hosts lose only saved dependent facts while historical board/audit identities remain", async () => {
  const { db, file } = await populatedControl();
  await executeDataCommand(db, { type: "forget-host", host: "example" });
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM forge_observations").all()).toHaveLength(1);
    expect(raw.prepare("SELECT * FROM board_threads").all()).toHaveLength(1);
    expect(raw.prepare("SELECT * FROM audit_records").all()).toHaveLength(2);
  });
});

test("board transitions preserve human waits, receipt atomicity and main-only retention", async () => {
  const api = await import("../../../../../src/main/data-import/board");
  const { db, file } = await fixture();
  await api.saveDatabaseBoardThread(db, boardThread);
  const actor = "orchestrator:repo";
  for (const [index, kind, author] of [
    [0, "decision-needed", actor],
    [1, "fyi", actor],
    [2, "answer", "human"],
    [3, "fyi", actor],
    [4, "request", actor],
  ] as const)
    await api.appendDatabaseBoardPost(db, {
      ...boardPost,
      id: `post-${String(index)}`,
      kind,
      author,
    });
  await expect(
    api.appendDatabaseBoardPost(
      db,
      { ...boardPost, id: "bad-receipt" },
      { ...boardReceipt, result: { thread: "thread-1", post: "different" } },
    ),
  ).rejects.toThrow();
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT state FROM board_threads").get()?.["state"]).toBe("waiting-repo");
    expect(raw.prepare("SELECT * FROM board_posts").all()).toHaveLength(5);
  });
});
test("audit retention prunes old/budgeted history and its links without deleting operations", async () => {
  const api = await import("../../../../../src/main/data-import/control");
  const { db, file } = await fixture();
  await api.reserveDatabaseOperation(db, storedOperation);
  await api.appendDatabaseAudit(db, {
    ...storedOperation.operation,
    actor,
    timestamp: historyTime,
  });
  await api.appendDatabaseAudit(db, {
    ...storedOperation.operation,
    actor,
    timestamp: historyTime,
  });
  expect((await api.pruneDatabaseAudit(db, Date.now(), 1)).value).toBe(3);
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM audit_records").all()).toEqual([]);
    expect(raw.prepare("SELECT * FROM control_operations").all()).toHaveLength(1);
  });
  await api.appendDatabaseAudit(db, {
    ...storedOperation.operation,
    actor,
    timestamp: "2000-01-01T00:00:00.000Z",
  });
  const aged = await db.write((orm) =>
    api.importControlRows(orm, {
      "control/actions-0.jsonl": JSON.stringify({
        ...storedOperation.operation,
        actor,
        timestamp: "2000-01-01T00:00:00.000Z",
      }),
    }),
  );
  expect(aged.value.pruned).toBe(1);
  await expect(api.pruneDatabaseAudit(db, -1)).rejects.toThrow();
});
test("restart starts new subscriptions at the current durable revision", async () => {
  const { db, profile } = await populatedControl();
  await db.close();
  connections.pop();
  const publications = new ViewChanges();
  const received = vi.fn();
  const off = publications.subscribe(received);
  const reopened = await ProfileDatabase.open(profile, publications);
  connections.push(reopened);
  try {
    await reopened.retryPublication();
    expect(received).not.toHaveBeenCalled();
    await reopened.write((orm) => {
      orm
        .insert(tables.offers)
        .values({ category: "setup", agent: "new-agent", answered: 1 })
        .run();
    });
    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.lastCall?.[0]).toEqual(new Set(["agents"]));
  } finally {
    off();
  }
});

test("repository forgetting keeps historical posts and requires saved sessions to close first", async () => {
  const { forgetDatabaseRepository } = await import("../../../../../src/main/data-import/control");
  const { db, file } = await populatedControl();
  await expect(forgetDatabaseRepository(db, repo)).rejects.toThrow("saved sessions");
  await executeDataCommand(db, { type: "remove-session", id: "parent" });
  const windowApi = await import("../../../../../src/main/data-import/windows");
  await windowApi.saveDatabaseWindows(db, [
    { id: "a", display: 1, bounds: { x: 0, y: 0, width: 900, height: 700 }, maximized: false },
  ]);
  await windowApi.saveDatabasePreview(db, "a", {
    id: "c".repeat(32),
    worktree: tree.path,
    relativePath: "readme.md",
    network: false,
  });
  await forgetDatabaseRepository(db, repo);
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM repositories").all()).toEqual([]);
    expect(raw.prepare("SELECT * FROM board_bindings").all()).toEqual([]);
    expect(raw.prepare("SELECT * FROM board_posts").all()).toHaveLength(1);
  });
});
test("health and host-diagnostic writers validate fixed metadata and independent retention reserves", async () => {
  const api = await import("../../../../../src/main/data-import/control");
  const { db, file } = await fixture();
  await api.saveDatabaseAgentHealth(db, "legacy", "codex", "a".repeat(64), "trusted");
  await api.saveDatabaseAgentHealth(db, "legacy", "codex", "b".repeat(64), "outdated");
  await expect(
    api.saveDatabaseAgentHealth(db, "outside", "codex", "a".repeat(64), "trusted"),
  ).rejects.toThrow();
  await db.write((orm) => {
    for (let index = 0; index < 33; index++)
      orm
        .insert(tables.terminalDiagnostics)
        .values({ kind: "exit", data: JSON.stringify({ time: historyTime }) })
        .run();
  });
  await api.appendDatabaseHostDiagnostic(db, "timeout", {
    time: historyTime,
    command: "ping",
    elapsedMs: 1,
  });
  await api.appendDatabaseHostDiagnostic(db, "exit", {
    time: historyTime,
    reason: "exit",
    serviceName: "utility",
    cause: "host-exit",
    snapshot: { liveTerminals: 1, hostMemoryKB: null, lastMessageAgeMs: 1, mainLagMs: 1 },
    gone: { type: "Utility", reason: "crashed", exitCode: 1 },
  });
  await expect(
    api.appendDatabaseHostDiagnostic(db, "timeout", {
      time: historyTime,
      command: "raw input",
      elapsedMs: 1,
    }),
  ).rejects.toThrow();
  await expect(
    api.appendDatabaseHostDiagnostic(db, "exit", {
      time: historyTime,
      reason: "exit",
      serviceName: "utility",
      cause: "invalid",
    }),
  ).rejects.toThrow();
  await expect(api.appendDatabaseHostDiagnostic(db, "unknown", {})).rejects.toThrow();
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM terminal_diagnostics WHERE kind='exit'").all()).toHaveLength(
      32,
    );
    expect(
      raw.prepare("SELECT * FROM terminal_diagnostics WHERE kind='timeout'").all(),
    ).toHaveLength(1);
  });
});

test("window imports preserve geometry and update high-water dates without restoring preview capabilities", async () => {
  const { db, profile, file } = await fixture();
  await put(profile, sources([]));
  await importLegacy(db, profile);
  const { importDatabaseWindows, reserveDatabaseUpdateActivity } = await import(
    "../../../../../src/main/data-import/windows"
  );
  const placement = {
    id: "board-1",
    display: -4,
    bounds: { x: -1000, y: 10, width: 900, height: 700 },
    maximized: true,
    scale: 100,
  };
  const preview = {
    id: "a".repeat(32),
    worktree: tree.path,
    relativePath: "docs/readme.md",
    network: false,
  };
  const input = {
    "windows.json": JSON.stringify([placement]),
    "window-size.json": JSON.stringify({ width: 1200, height: 800 }),
    "update-activity.json": JSON.stringify({ d: "2026-11-17", w: "2026-11-16", m: "2026-11-01" }),
    "previews-board-1.json": JSON.stringify([preview]),
  };
  for (const [name, value] of Object.entries(input))
    await writeFile(join(profile, name), value, { mode: 0o600 });
  const result = await importDatabaseWindows(db, profile);
  expect(JSON.parse(result.value.report)).toMatchObject({ accepted: 6, quarantined: 0 });
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT * FROM windows").get()).toMatchObject({
      id: "board-1",
      display: -4,
      x: -1000,
      maximized: 1,
    });
    expect(raw.prepare("SELECT * FROM preview_records").get()).toMatchObject({
      window: "board-1",
      worktree: tree.path,
      network: 0,
    });
    expect(() => {
      raw.exec("DELETE FROM windows");
    }).toThrow();
    expect(() => raw.prepare("DELETE FROM worktrees WHERE path=?").run(tree.path)).toThrow();
    expect(() => {
      raw.exec("UPDATE preview_records SET network=1");
    }).toThrow();
    expect(() => {
      raw.exec("UPDATE update_activity SET date='2026-02-30'");
    }).toThrow();
    expect(() => {
      raw.exec("UPDATE windows SET width=0");
    }).toThrow();
  });
  expect((await reserveDatabaseUpdateActivity(db, new Date("2026-11-17T12:00:00Z"))).value).toBe(
    "",
  );
  expect((await reserveDatabaseUpdateActivity(db, new Date("2026-11-18T12:00:00Z"))).value).toBe(
    "?d=1",
  );
  expect((await reserveDatabaseUpdateActivity(db, new Date("2025-01-01T12:00:00Z"))).value).toBe(
    "",
  );
  for (const [name, value] of Object.entries(input))
    expect(await readFile(join(profile, name), "utf8")).toBe(value);
  await rm(join(profile, "previews-board-1.json"));
  expect((await importDatabaseWindows(db, profile)).value.alreadyImported).toBe(true);
});
test("window domain writes replace intended child metadata and reserve update dates atomically", async () => {
  const { db, file } = await fixture();
  const api = await import("../../../../../src/main/data-import/windows");
  const a = {
    id: "a",
    display: 1,
    bounds: { x: 0, y: 0, width: 900, height: 700 },
    maximized: false,
  };
  const b = { ...a, id: "b" };
  const preview = {
    id: "a".repeat(32),
    worktree: "/unmanaged",
    relativePath: "readme.md",
    network: false,
  };
  await api.saveDatabaseWindows(db, [a, b]);
  await api.saveDatabasePreview(db, "a", preview);
  await api.saveDatabasePreview(db, "a", preview);
  await expect(api.forgetDatabasePreview(db, "b", preview.id)).rejects.toThrow("owner");
  await api.saveDatabasePreview(db, "b", preview);
  await api.forgetDatabasePreview(db, "b", preview.id);
  await api.forgetDatabasePreview(db, "b", preview.id);
  await api.saveDatabasePreview(db, "a", preview);
  await api.saveDatabaseWindows(db, [b]);
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT count(*) AS n FROM preview_records").get()?.["n"]).toBe(0);
    expect(raw.prepare("SELECT id FROM windows").get()?.["id"]).toBe("b");
  });
  await api.saveDatabaseWindowSize(db, { width: 1000, height: 600 });
  await api.saveDatabaseWindowSize(db, { width: 1100, height: 650 });
  expect(
    (await api.reserveDatabaseUpdateActivity(db, new Date("2026-12-01T01:00:00Z"))).value,
  ).toBe("?d=1&w=1&m=1");
  expect(
    (await api.reserveDatabaseUpdateActivity(db, new Date("2026-12-01T01:00:00Z"))).value,
  ).toBe("");
  await api.saveDatabaseWindows(db, []);
  expect(() => api.saveDatabaseWindows(db, [a, a])).toThrow("Duplicate");
  expect(() => api.saveDatabaseWindows(db, null)).toThrow();
  expect(() => api.saveDatabaseWindows(db, [{}])).toThrow();
  expect(() => api.saveDatabaseWindowSize(db, { width: 0, height: 2 })).toThrow();
  await expect(api.saveDatabasePreview(db, "!", preview)).rejects.toThrow();
  await expect(api.saveDatabasePreview(db, "missing", preview)).rejects.toThrow();
  await expect(api.saveDatabasePreview(db, "a", { ...preview, network: true })).rejects.toThrow();
});
test("window importer quarantines invalid rows, orphans and duplicate identities", async () => {
  const { db, file } = await fixture();
  const { importWindowRows } = await import("../../../../../src/main/data-import/windows");
  const a = {
    id: "a",
    display: 1,
    bounds: { x: 0, y: 0, width: 900, height: 700 },
    maximized: false,
  };
  const p = {
    id: "b".repeat(32),
    worktree: "/unmanaged",
    relativePath: "readme.md",
    network: false,
  };
  const result = await db.write((tx) =>
    importWindowRows(tx, {
      "windows.json": JSON.stringify([a, a, {}]),
      "window-size.json": "{}",
      "update-activity.json": JSON.stringify({
        d: "2026-02-30",
        w: "2026-11-17",
        m: "2026-11-17",
        x: "2026-11-17",
      }),
      "previews-orphan.json": JSON.stringify([p]),
      "previews-a.json": JSON.stringify([p, p, { ...p, network: true }]),
      ignored: null,
    }),
  );
  expect(result.value).toEqual({ accepted: 2, quarantined: 10 });
  const broken = [
    {
      "windows.json": "{}",
      "update-activity.json": "[]",
      "window-size.json": "!",
      "previews-a.json": "{}",
    },
    { "windows.json": null, "previews-a.json": "!" },
    {
      "windows.json": JSON.stringify(Array.from({ length: 33 }, () => a)),
      "previews-a.json": JSON.stringify(Array.from({ length: 257 }, () => p)),
    },
  ];
  for (const input of broken) await db.write((tx) => importWindowRows(tx, input));
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT count(*) AS n FROM windows").get()?.["n"]).toBe(1);
    expect(raw.prepare("SELECT worktree FROM preview_records").get()?.["worktree"]).toBe(null);
  });
});
test("window metadata enforces per-window preview capacity while allowing updates", async () => {
  const { db } = await fixture();
  const api = await import("../../../../../src/main/data-import/windows");
  await api.saveDatabaseWindows(db, [
    { id: "a", display: 1, bounds: { x: 0, y: 0, width: 900, height: 700 }, maximized: false },
  ]);
  for (let i = 0; i < 256; i++)
    await api.saveDatabasePreview(db, "a", {
      id: i.toString(16).padStart(32, "0"),
      worktree: "/unmanaged",
      relativePath: "readme.md",
      network: false,
    });
  await api.saveDatabasePreview(db, "a", {
    id: "0".repeat(32),
    worktree: "/unmanaged",
    relativePath: "changed.md",
    network: false,
  });
  await expect(
    api.saveDatabasePreview(db, "a", {
      id: "f".repeat(32),
      worktree: "/unmanaged",
      relativePath: "readme.md",
      network: false,
    }),
  ).rejects.toThrow("capacity");
});

test("recovery encrypts rejected raw input", async () => {
  const { importDatabaseEnvironment } = await import(
    "../../../../../src/main/data-import/environment"
  );
  const { db, profile, file } = await fixture();
  const marker = "fixture-secret-marker";
  await writeFile(
    join(profile, "environment.json"),
    JSON.stringify({
      version: 1,
      lists: {
        all: [{ name: "URL", value: `https://user:${marker}@example.test` }],
      },
    }),
    { mode: 0o600 },
  );
  const result = await importDatabaseEnvironment(db, profile, encryptedFixture());
  expect(JSON.parse(result.value.report)).toEqual({ accepted: 0, quarantined: 1 });
  expect(
    (await readFile(join(profile, "data/recovery/environment-v1.json"))).includes(
      Buffer.from(marker),
    ),
  ).toBe(false);
  expect((await readFile(file)).includes(Buffer.from(marker))).toBe(false);
});

test("pending removals persist only a validated projection", async () => {
  const { db } = await fixture();
  const input = sources([]);
  input["worktrees.json"] = JSON.stringify({
    version: 1,
    repositories: [repo],
    managed: [],
    pendingRemovals: [
      {
        path: tree.path,
        repository: repo,
        root: repo,
        directoryIdentity: "dir",
        token: "fixture-secret-marker",
      },
    ],
  });
  await db.write((orm) => importRows(orm, input));
  const rows = await db.read((orm) => orm.select().from(tables.pendingRemovals).all());
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0]?.data ?? "null")).toEqual({
    path: tree.path,
    repository: repo,
    root: repo,
    directoryIdentity: "dir",
  });
});

test.each(process.platform === "win32" ? ["file"] : ["file", "symlink"])(
  "database rejects %s replacement after private verification before any SQL",
  async (replacement) => {
    const { profile, db, file } = await fixture();
    await db.close();
    connections.splice(connections.indexOf(db), 1);
    const external = join(profile, "external.sqlite");
    await writeFile(external, "", { mode: 0o600 });
    const verify = privateFiles.verifyPrivate;
    let replaced = false;
    const spy = vi
      .spyOn(privateFiles, "verifyPrivate")
      .mockImplementation(async (path, directory) => {
        await verify(path, directory);
        if (path === file && !replaced) {
          replaced = true;
          await rm(file);
          if (replacement === "symlink") await symlink(external, file);
          else await rename(external, file);
        }
      });
    try {
      await expect(ProfileDatabase.open(profile)).rejects.toThrow();
      expect(await readFile(replacement === "symlink" ? external : file)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  },
);

test("interrupted dynamic import resumes frozen manifest before failed discovery", async () => {
  const { db, profile } = await fixture();
  await put(profile);
  const discover = vi.fn(() => Promise.resolve(["settings.json"]));
  await expect(
    importLegacyGroup(
      db,
      profile,
      "resume-regression",
      discover,
      () => {
        throw new Error("interrupted");
      },
      [],
    ),
  ).rejects.toThrow("interrupted");
  discover.mockImplementation(() => Promise.reject(new Error("discovery failed")));
  await writeFile(join(profile, "settings.json"), "changed");
  const ingest = vi.fn(
    (_orm: Parameters<typeof importRows>[0], input: Parameters<typeof importRows>[1]) => ({
      frozen: input["settings.json"] === sources()["settings.json"],
    }),
  );
  const result = await importLegacyGroup(db, profile, "resume-regression", discover, ingest, []);
  expect(JSON.parse(result.value.report)).toEqual({ frozen: true });
  expect(discover).toHaveBeenCalledTimes(1);
});

test("transient decrypt failure rolls back the whole environment import and retries", async () => {
  const { importDatabaseEnvironment } = await import(
    "../../../../../src/main/data-import/environment"
  );
  const { db, profile } = await fixture();
  const cipher = encryptedFixture();
  const encoded = cipher.encrypt("recoverable").toString("base64");
  await writeFile(
    join(profile, "environment.json"),
    JSON.stringify({
      version: 1,
      lists: {
        all: [
          { name: "PLAIN", value: "first" },
          { name: "SECRET", secret: true, cipher: encoded },
        ],
      },
    }),
    { mode: 0o600 },
  );
  cipher.decrypt.mockImplementationOnce(() => {
    throw new Error("transient keychain failure");
  });
  await expect(importDatabaseEnvironment(db, profile, cipher)).rejects.toThrow("keychain");
  expect(await db.read((orm) => orm.select().from(tables.imports).all())).toEqual([]);
  expect(await db.read((orm) => orm.select().from(tables.environmentEntries).all())).toEqual([]);
  expect(await db.read((orm) => orm.select().from(tables.quarantine).all())).toEqual([]);
  expect((await importDatabaseEnvironment(db, profile, cipher)).value.alreadyImported).toBe(false);
  expect(await db.read((orm) => orm.select().from(tables.environmentEntries).all())).toHaveLength(
    2,
  );
});

test.each(["unsupported", "unavailable", "encrypt"])(
  "recovery fails closed when cipher is %s",
  async (failure) => {
    const { db, profile } = await fixture();
    const cipher = encryptedFixture();
    if (failure === "unsupported") cipher.supported.mockReturnValue(false);
    if (failure === "unavailable") cipher.available.mockReturnValue(false);
    if (failure === "encrypt")
      cipher.encrypt.mockImplementation(() => {
        throw new Error("keychain failed");
      });
    const isolated = await ProfileDatabase.open(profile, new ViewChanges(), cipher);
    connections.push(isolated);
    await expect(importLegacy(isolated, profile)).rejects.toThrow("keychain");
    expect(await db.read((orm) => orm.select().from(tables.imports).all())).toEqual([]);
    await expect(
      readFile(join(profile, "data/recovery/hosts-worktrees-sessions-v1.json")),
    ).rejects.toThrow();
  },
);

test("imports production decision posts, their bound heads and receipts", async () => {
  const { importBoardRows } = await import("../../../../../src/main/data-import/board");
  const { MessageBoard } = await import("../../../../../src/main/control/message-board");
  const { db, file, profile } = await fixture();
  const directory = await privateFiles.privateDirectory(profile);
  const repository = boardThread.repository;
  const headSha = "a".repeat(64);
  const board = await MessageBoard.open(
    directory,
    () => [{ id: repository, name: "Fixture" }],
    vi.fn(),
    () => ({ headSha }),
  );
  const question = await board.append(`orchestrator:${repository}`, "grant", {
    kind: "question",
    text: "A decision",
    title: "Release",
    to: [repository],
    questions: [
      {
        title: "Proceed?",
        options: [
          { id: "go", label: "Proceed" },
          { id: "no", label: "Hold" },
        ],
        subject: { pullRequest: 340, headSha },
      },
    ],
    idempotencyKey: "question-key",
  });
  const answer = await board.answer({
    answers: [{ post: question.post, index: 0, option: "go" }],
    idempotencyKey: "answer-key",
  });
  const original = await readFile(join(directory, "board.json"), "utf8");
  const report = await db.write((orm) => importBoardRows(orm, original));
  expect(report.value).toMatchObject({ accepted: 5, quarantined: 0 });
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT id, kind FROM board_posts ORDER BY rowid").all()).toEqual([
      { id: question.post, kind: "question" },
      { id: answer.post, kind: "answer" },
    ]);
    expect(raw.prepare("SELECT post FROM board_receipts").all()).toHaveLength(2);
    expect(
      raw
        .prepare(
          "SELECT json_extract(data, '$.answers[0].subject.headSha') AS sha FROM board_posts WHERE kind='answer'",
        )
        .get(),
    ).toEqual({ sha: headSha });
  });
  const { appendDatabaseBoardPost } = await import("../../../../../src/main/data-import/board");
  await expect(
    appendDatabaseBoardPost(db, {
      ...boardPost,
      id: "duplicate-decision",
      thread: question.thread,
      kind: "answer",
      answers: [
        { post: question.post, index: 0, option: "go", subject: { pullRequest: 340, headSha } },
      ],
    }),
  ).rejects.toThrow("unavailable");
});

test("upgrading the board post constraint preserves existing posts and composite receipts", async () => {
  const profile = await mkdtemp(join(tmpdir(), "foom-sqlite-board-upgrade-"));
  roots.push(profile);
  const directory = await privateFiles.privateDirectory(profile, "data");
  const file = join(directory, "profile.sqlite");
  await (await privateFiles.createPrivateFile(file)).close();
  const migrations = join(process.cwd(), "src/main/data/sqlite/migrations");
  const old = (await readdir(migrations))
    .sort()
    .filter((name) => name <= "20261118055629_remove_repository_setup");
  const scripts = await Promise.all(
    old.map((name) => readFile(join(migrations, name, "migration.sql"), "utf8")),
  );
  inspect(file, (raw) => {
    raw.exec("CREATE TABLE _schema (version INTEGER PRIMARY KEY, digest TEXT NOT NULL) STRICT");
    for (const [index, script] of scripts.entries()) {
      raw.exec(script);
      raw
        .prepare("INSERT INTO _schema VALUES (?, ?)")
        .run(index + 1, createHash("sha256").update(script).digest("hex"));
    }
    raw.exec(`PRAGMA user_version=${String(scripts.length)}`);
    raw
      .prepare("INSERT INTO board_threads (id, state, data) VALUES (?, ?, ?)")
      .run(boardThread.id, boardThread.state, JSON.stringify(boardThread));
    raw
      .prepare("INSERT INTO board_posts VALUES (?, ?, ?, ?)")
      .run(boardPost.id, boardPost.thread, boardPost.kind, JSON.stringify(boardPost));
    raw
      .prepare("INSERT INTO board_receipts VALUES (?, ?, ?, ?, ?)")
      .run(
        boardReceipt.scope,
        boardReceipt.key,
        boardReceipt.hash,
        boardReceipt.result.thread,
        boardReceipt.result.post,
      );
  });
  const upgraded = await ProfileDatabase.open(profile);
  connections.push(upgraded);
  inspect(file, (raw) => {
    expect(raw.prepare("SELECT data FROM board_posts").all()).toEqual([
      { data: JSON.stringify(boardPost) },
    ]);
    expect(raw.prepare("SELECT post FROM board_receipts").all()).toEqual([{ post: boardPost.id }]);
    expect(() => {
      raw.exec("DELETE FROM board_posts");
    }).toThrow(/FOREIGN KEY/u);
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(raw.prepare("PRAGMA user_version").get()?.["user_version"]).toBeGreaterThan(
      scripts.length,
    );
  });
});
