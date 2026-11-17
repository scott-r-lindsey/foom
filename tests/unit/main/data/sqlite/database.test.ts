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
    expect(list).toHaveLength(11);
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
