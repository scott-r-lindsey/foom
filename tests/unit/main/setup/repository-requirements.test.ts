import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RepositoryRequirementsStore } from "../../../../src/main/setup/repository-requirements";
import { nativeDeadline } from "../../../helpers/native-test-policy";

vi.mock("../../../../src/node-common/private-file-permissions", () => ({
  windowsAcl: vi.fn(async () => {}),
}));

vi.setConfig({ testTimeout: nativeDeadline(5000) });

let profile: string;
let repository: string;
let id: string;
let store: RepositoryRequirementsStore;
const firstId = "13d2354c-75d5-4771-8d2a-f0179896e640";
const otherId = "13d2354c-75d5-4771-8d2a-f0179896e641";
const preserve = vi.fn<(_path: string, _id: string) => Promise<void>>();
beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), "repository-requirements-"));
  repository = join(profile, "repository");
  id = firstId;
  preserve.mockReset().mockResolvedValue(undefined);
  store = new RepositoryRequirementsStore(
    profile,
    (path) => {
      if (path === repository) return id;
      throw new Error("Unknown repository");
    },
    preserve,
  );
});
afterEach(async () => {
  await rm(profile, { recursive: true, force: true });
});

function settings(action: "read" | "edit" | "clear", fields: Record<string, unknown> = {}) {
  return store.settings({ action, repository, ...fields });
}
function run(record = true, signal = new AbortController().signal, id = "run") {
  return store.forRun({
    id,
    agent: "Codex",
    host: "dozer",
    repositories: [repository],
    record,
    signal,
  });
}
function request(markdown = "# Install Node 24", runId = "run") {
  return { runId, repository, markdown };
}

test("persists provenance, preserves human edits in setup context and replaces the previous note", async () => {
  const first = await run();
  expect(first.notes).toEqual([{ repository, note: null }]);
  await first.write?.(request());
  expect(preserve).toHaveBeenCalledWith(repository, firstId);
  const original = await settings("read");
  expect(original).toMatchObject({ markdown: request().markdown, agent: "Codex", host: "dozer" });
  const edited = await settings("edit", {
    revision: original?.revision,
    markdown: "# Node 24 with Xvfb",
  });
  expect(edited).toMatchObject({
    recordedAt: original?.recordedAt,
    markdown: "# Node 24 with Xvfb",
  });
  expect(typeof edited?.editedAt).toBe("number");
  const second = await run(true, undefined, "second");
  expect(second.notes).toEqual([{ repository, note: edited }]);
  await second.write?.(request("# Node 24 with Xvfb\n\nUse Corepack.", "second"));
  const replaced = await settings("read");
  expect(replaced).toMatchObject({
    editedAt: edited?.editedAt,
    markdown: "# Node 24 with Xvfb\n\nUse Corepack.",
  });
  await expect(settings("clear", { revision: replaced?.revision })).resolves.toBeNull();
  await expect(settings("read")).resolves.toBeNull();
});

test("rejects other runs, unselected repositories, forged provenance and malformed Markdown", async () => {
  const live = await run();
  for (const invalid of [
    null,
    request("valid", "other"),
    { ...request(), repository: join(profile, "other") },
    { ...request(), agent: "Forged" },
    { ...request(), markdown: ["unexpected"] },
    request(" "),
    request("text\u0000"),
    request("text\u202e"),
    request("\ud800"),
    request("a".repeat(16385)),
    request("é".repeat(8193)),
  ])
    expect(() => live.write?.(invalid)).toThrow("Host requirements write refused");
  await expect(live.write?.(request("é".repeat(8192)))).resolves.toBeUndefined();
});

test("refuses disabled or ended runs and invalidates writes after re-registration", async () => {
  expect((await run(false)).write).toBeUndefined();
  const abort = new AbortController();
  const live = await run(true, abort.signal);
  abort.abort();
  await expect(live.write?.(request())).rejects.toThrow();
  await expect(run(true, abort.signal)).rejects.toThrow();
  const replaced = await run();
  id = otherId;
  await expect(replaced.write?.(request())).rejects.toThrow("write refused");
  await expect(settings("read")).resolves.toBeNull();
});

test("refuses stale revisions and a simultaneous replacement", async () => {
  const one = await run();
  const two = await run(true, undefined, "second");
  await one.write?.(request());
  await expect(two.write?.(request("Second note", "second"))).rejects.toThrow("changed");
  const note = await settings("read");
  await expect(settings("clear", { revision: otherId })).rejects.toThrow("changed");
  const pending = await run();
  await settings("clear", { revision: note?.revision });
  await expect(pending.write?.(request())).rejects.toThrow("changed");
});

test("refuses unknown repositories and invalid saved records", async () => {
  const live = await run();
  await live.write?.(request());
  await expect(settings("read", { repository: join(profile, "other") })).rejects.toThrow(
    "Unknown repository",
  );
  expect(() => settings("read", { unexpected: true })).toThrow("Invalid host requirements request");
  expect(() => settings("edit", { revision: firstId, markdown: "" })).toThrow(
    "Invalid host requirements request",
  );
  const directory = join(profile, "repository-requirements");
  const [name] = await readdir(directory);
  if (!name) throw new Error("Missing stored requirements");
  const path = join(directory, name);
  await writeFile(path, JSON.stringify({ ...(await settings("read")), host: "\u0000" }));
  await expect(settings("read")).rejects.toThrow("Invalid saved host requirements");
  await chmod(path, 0o600);
  await writeFile(path, "x".repeat(65536));
  await expect(settings("read")).rejects.toThrow("Unable to read host requirements");
});

test("a duplicate claimed registration ID cannot expose another repository's note", async () => {
  const other = join(profile, "other");
  store = new RepositoryRequirementsStore(profile, () => firstId);
  const live = await run();
  await live.write?.(request());
  await expect(settings("read", { repository: other })).resolves.toBeNull();
});
