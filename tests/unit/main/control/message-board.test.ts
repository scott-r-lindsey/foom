import { object } from "../../../../src/shared/control-validation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MessageBoard } from "../../../../src/main/control/message-board";
import { privateDirectory } from "../../../../src/node-common/private-files";
import { mcpToolResponse } from "../../../../src/node-common/mcp-response";
import {
  boardPost,
  boardText,
  boardLinks,
  threadState,
  postKind,
} from "../../../../src/shared/message-board-validation";
const repos = () => [
  { id: "a", name: "A" },
  { id: "b", name: "B" },
];
const post = (key = "one") => ({
  to: ["b"],
  title: "Release",
  kind: "request",
  text: "Release metadata?",
  links: ["#973", "https://example.org/release"],
  idempotencyKey: key,
});
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "foom-board-"));
  roots.push(root);
  return privateDirectory(root);
}

describe("message validation", () => {
  it("accepts bounded Unicode and rejects spoofed identities, invalid kinds, links and fields", () => {
    expect(boardPost(post())).toMatchObject({ kind: "request" });
    expect(boardText("é".repeat(4096))).toHaveLength(4096);
    for (const text of [
      "",
      "  ",
      "x\n",
      "x\t",
      "x\u0000",
      "x\u007f",
      "x\u202e",
      "\ud800",
      "é".repeat(4097),
      3,
    ])
      expect(() => boardText(text)).toThrow("invalid_request");
    for (const kind of [null, "decision", "human"]) expect(() => postKind(kind)).toThrow();
    for (const state of ["closed", null]) expect(() => threadState(state)).toThrow();
    for (const links of [
      null,
      Array.from({ length: 11 }, () => "#1"),
      ["http://example.org"],
      ["https://user:pass@example.org"],
      ["#0"],
      ["#-1"],
      ["junk"],
      ["https://example.org/a b"],
      ["https://example.org/" + "x".repeat(2048)],
    ])
      expect(() => boardLinks(links)).toThrow();
    for (const change of [
      { author: "human" },
      { role: "orchestrator" },
      { kind: "bad" },
      { to: [] },
      { to: ["b", "b"] },
      { to: Array(17).fill("b") },
      { to: ["../x"] },
      { thread: "t" },
      { title: "x".repeat(201) },
      { idempotencyKey: "!" },
    ])
      expect(() => boardPost({ ...post(), ...change })).toThrow();
    expect(boardPost({ thread: "t", kind: "answer", text: "yes", idempotencyKey: "k" })).toEqual({
      thread: "t",
      kind: "answer",
      text: "yes",
      links: [],
      idempotencyKey: "k",
    });
  });
});

describe("main-owned message history", () => {
  it("appends immutable posts, preserves a decision wait until a human reply, resolves and deduplicates", async () => {
    const save = vi.fn(() => Promise.resolve());
    const changed = vi.fn();
    const board = new MessageBoard(save, repos, changed);
    const first = await board.append("orchestrator:a", "grant-a", post());
    expect(await board.append("orchestrator:a", "grant-a", post())).toEqual(first);
    await expect(
      board.append("orchestrator:a", "grant-a", { ...post(), text: "changed" }),
    ).rejects.toThrow("conflict");
    const original = board.read({ thread: first.thread }).posts[0];
    expect(board.threads({}, "a").threads[0]?.state).toBe("waiting-repo");
    await board.append("orchestrator:b", "grant-b", {
      thread: first.thread,
      kind: "decision-needed",
      text: "May I start?",
      idempotencyKey: "decision",
    });
    await board.append("orchestrator:a", "grant-a", {
      thread: first.thread,
      kind: "fyi",
      text: "Still waiting",
      idempotencyKey: "fyi",
    });
    expect(board.read({ thread: first.thread }).thread.state).toBe("waiting-human");
    await board.append("human", "human", {
      thread: first.thread,
      kind: "answer",
      text: "Approved",
      idempotencyKey: "reply",
    });
    expect(board.read({ thread: first.thread }).thread.state).toBe("waiting-repo");
    await board.append("orchestrator:b", "grant-b", {
      thread: first.thread,
      kind: "answer",
      text: "Done",
      idempotencyKey: "answer",
    });
    expect(board.read({ thread: first.thread }).thread.state).toBe("open");
    const resolved = await board.resolve("human", {
      thread: first.thread,
      idempotencyKey: "resolve",
    });
    expect(
      await board.resolve("human", { thread: first.thread, idempotencyKey: "resolve" }),
    ).toEqual(resolved);
    expect(board.read({ thread: first.thread }).thread.state).toBe("resolved");
    expect(board.read({ thread: first.thread }).posts[0]).toEqual(original);
    await expect(
      board.append("orchestrator:a", "grant-a", {
        thread: first.thread,
        kind: "fyi",
        text: "late",
        idempotencyKey: "late",
      }),
    ).rejects.toThrow("conflict");
    const view = board.read({ thread: first.thread });
    view.posts[0]?.links.push("#999");
    view.thread.to.push("c");
    expect(board.read({ thread: first.thread }).posts[0]).toEqual(original);
    expect(changed).toHaveBeenCalledTimes(6);
    expect(save).toHaveBeenCalledTimes(6);
  });
  it("enforces scope, open recipients, author identities and exact read/resolve payloads", async () => {
    const board = new MessageBoard(async () => {}, repos);
    const first = await board.append("orchestrator:a", "a", post());
    expect(board.threads({}, "c").threads).toEqual([]);
    expect(() => board.read({ thread: first.thread }, "c")).toThrow("not_found");
    expect(() => board.read({ thread: first.thread, after: "missing" })).toThrow("not_found");
    expect(() => board.threads({ after: "missing" })).toThrow("not_found");
    expect(board.threads({ repository: "b", state: "open" }).threads).toEqual([]);
    expect(board.threads({ repository: "b", state: "waiting-repo" }).threads).toHaveLength(1);
    await expect(
      board.append("orchestrator:c", "c", { ...post("foreign"), to: ["b"] }),
    ).rejects.toThrow("not_found");
    await expect(
      board.append("orchestrator:a", "a", { ...post("unknown"), to: ["c"] }),
    ).rejects.toThrow("not_found");
    await expect(board.append("human", "human", post())).rejects.toThrow("invalid_request");
    expect(() => board.append("orchestrator:!", "a", post())).toThrow();
    expect(() => board.append("invalid" as "human", "a", post())).toThrow();
    await expect(
      board.resolve("c", { thread: first.thread, idempotencyKey: "no" }, "c"),
    ).rejects.toThrow("not_found");
    expect(() =>
      board.resolve("a", { thread: first.thread, author: "human", idempotencyKey: "no" }),
    ).toThrow();
    expect(() => board.read({ thread: first.thread, text: "x" })).toThrow();
    expect(() => board.threads({ role: "human" })).toThrow();
  });
  it("serializes retries, refuses failed saves and revoked queued writers, and emits only addressed other-author events", async () => {
    let release = () => {};
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const board = new MessageBoard(save, repos);
    const eventA = board.event("a"),
      eventB = board.event("b"),
      eventC = board.event("c");
    const first = board.append("orchestrator:a", "a", post());
    let live = true;
    const queued = board.append("orchestrator:a", "a", post("queued"), () => {
      if (!live) throw new Error("revoked");
    });
    await vi.waitFor(() => {
      expect(save).toHaveBeenCalledOnce();
    });
    live = false;
    release();
    await first;
    await expect(queued).rejects.toThrow("revoked");
    expect(board.event("a")).toBe(eventA);
    expect(board.event("b")).not.toBe(eventB);
    expect(board.event("c")).toBe(eventC);
    const failing = new MessageBoard(() => Promise.reject(new Error("disk")), repos);
    await expect(failing.append("orchestrator:a", "a", post())).rejects.toThrow("unavailable");
    expect(failing.threads({}).threads).toEqual([]);
    await expect(failing.append("orchestrator:a", "a", post())).rejects.toThrow("unavailable");
  });
  it("pages threads and posts without losing append order", async () => {
    const board = new MessageBoard(async () => {}, repos);
    let id = "";
    for (let i = 0; i < 101; i++)
      id = (await board.append("orchestrator:a", "a", post(`thread-${String(i)}`))).thread;
    const list = board.threads({});
    expect(list.threads).toHaveLength(100);
    expect(list.next).toBe(list.threads.at(-1)?.id);
    expect(board.threads({ after: list.next }).threads).toHaveLength(1);
    for (let i = 0; i < 8; i++)
      await board.append("orchestrator:b", "b", {
        thread: id,
        kind: "fyi",
        text: String(i),
        idempotencyKey: `post-${String(i)}`,
      });
    const read = board.read({ thread: id });
    expect(read.posts).toHaveLength(8);
    expect(read.next).toBe(read.posts.at(-1)?.id);
    expect(board.read({ thread: id, after: read.next }).posts[0]?.text).toBe("7");
  });
  it("persists history and receipts across restart with private files", async () => {
    const dir = await directory();
    const board = await MessageBoard.open(dir, repos, () => {});
    const first = await board.append("orchestrator:a", "a", post());
    await board.append("human", "human", {
      thread: first.thread,
      kind: "answer",
      text: "ok",
      idempotencyKey: "reply",
    });
    await board.resolve("human", { thread: first.thread, idempotencyKey: "resolve" });
    const restored = await MessageBoard.open(dir, repos, () => {});
    expect(restored.read({ thread: first.thread })).toEqual(board.read({ thread: first.thread }));
    expect(await restored.append("orchestrator:a", "a", post())).toEqual(first);
  });
  it("fails closed on malformed, redirected, oversized and insecure history", async () => {
    const dir = await directory();
    const path = join(dir, "board.json");
    const board = await MessageBoard.open(dir, repos, () => {});
    await board.append("orchestrator:a", "a", post());
    const valid = object(JSON.parse(await readFile(path, "utf8")));
    const records = (value: unknown) => {
      if (!Array.isArray(value)) throw new Error("array expected");
      return value.map(object);
    };
    const base = {
      version: 1,
      threads: records(valid["threads"]),
      posts: records(valid["posts"]),
      receipts: records(valid["receipts"]),
    };
    const variants: unknown[] = [null, {}, { ...base, version: 2 }, { ...base, threads: {} }];
    for (const field of ["id", "title", "repository", "to", "state", "createdAt", "updatedAt"])
      variants.push({ ...base, threads: [{ ...base.threads[0], [field]: null }] });
    for (const field of ["id", "thread", "author", "kind", "text", "links", "timestamp"])
      variants.push({ ...base, posts: [{ ...base.posts[0], [field]: null }] });
    variants.push(
      { ...base, posts: [{ ...base.posts[0], thread: "unknown" }] },
      { ...base, threads: [...base.threads, ...base.threads] },
      { ...base, posts: [...base.posts, ...base.posts] },
      { ...base, receipts: [...base.receipts, ...base.receipts] },
      { ...base, threads: [{ ...base.threads[0], createdAt: "yesterday" }] },
      { ...base, receipts: [{ ...base.receipts[0], result: { thread: null, post: null } }] },
    );
    for (const value of variants) {
      await writeFile(path, JSON.stringify(value));
      await expect(MessageBoard.open(dir, repos, () => {})).rejects.toThrow("unavailable");
    }
    await writeFile(path, "{broken");
    await expect(MessageBoard.open(dir, repos, () => {})).rejects.toThrow();
    await writeFile(path, Buffer.alloc(32 * 1024 * 1024 + 1));
    await expect(MessageBoard.open(dir, repos, () => {})).rejects.toThrow();
    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await expect(MessageBoard.open(dir, repos, () => {})).rejects.toThrow();
      await chmod(path, 0o600);
    }
    if (process.platform !== "win32") {
      await rm(path);
      await symlink("missing", path);
      await expect(MessageBoard.open(dir, repos, () => {})).rejects.toThrow();
    }
  });
});

it("refuses capacity without evicting or rewriting prior history", async () => {
  const board = new MessageBoard(
    () => Promise.resolve(),
    repos,
    () => {},
    { bytes: 65536, receipts: 1 },
  );
  const first = await board.append("orchestrator:a", "a", post());
  await expect(board.append("orchestrator:a", "a", post("second"))).rejects.toThrow("capacity");
  expect(await board.append("orchestrator:a", "a", post())).toEqual(first);
  const tiny = new MessageBoard(
    () => Promise.resolve(),
    repos,
    () => {},
    { bytes: 1, receipts: 5 },
  );
  await expect(tiny.append("orchestrator:a", "a", post())).rejects.toThrow("capacity");
  expect(tiny.threads({}).threads).toEqual([]);
});

it("budgets the complete MCP response when text and links need JSON escaping", async () => {
  const board = new MessageBoard(() => Promise.resolve(), repos);
  const first = await board.append("orchestrator:a", "a", post());
  for (let i = 0; i < 8; i++)
    await board.append("orchestrator:b", "b", {
      thread: first.thread,
      kind: "link",
      text: '"'.repeat(8192),
      links: Array(10).fill("https://example.org/" + '"'.repeat(2000)),
      idempotencyKey: `escaped-${String(i)}`,
    });
  const read = board.read({ thread: first.thread });
  expect(read.next).not.toBeNull();
  expect(
    Buffer.byteLength(JSON.stringify(mcpToolResponse("\u0000".repeat(200), read))),
  ).toBeLessThanOrEqual(256 * 1024);
  expect(read.posts.length).toBeGreaterThan(1);
});

it("refuses oversized discovery metadata even without thread rows", () => {
  const board = new MessageBoard(
    () => Promise.resolve(),
    () => [{ id: "a", name: '"'.repeat(65536) }],
  );
  expect(() => board.threads({})).toThrow("capacity");
});
