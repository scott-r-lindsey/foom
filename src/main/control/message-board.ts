import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivate, verifyPrivate } from "../../node-common/private-files";
import type {
  BoardMutation,
  BoardRead,
  BoardRepository,
  BoardThreads,
  MessagePost,
  MessageThread,
} from "../../shared/message-board";
import {
  BOARD_NOTICE,
  boardLinks,
  boardPost,
  boardResolve,
  boardText,
  postKind,
  threadState,
} from "../../shared/message-board-validation";
import { ControlError, exact, identifier, object } from "../../shared/control-validation";
import { MCP_ID_LIMIT, MCP_RESPONSE_LIMIT, mcpToolResponse } from "../../node-common/mcp-response";

interface Receipt {
  scope: string;
  key: string;
  hash: string;
  result: BoardMutation;
}
interface Data {
  version: 1;
  threads: MessageThread[];
  posts: MessagePost[];
  receipts: Receipt[];
}
const CHILD_RETENTION = 30 * 24 * 60 * 60 * 1000;
const LIMIT = 32 * 1024 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function pageRows<T extends { id: string }, R>(
  rows: T[],
  start: number,
  maximum: number,
  response: (page: T[], next: string | null) => R,
): R {
  const next = (page: T[]) =>
    rows.length > start + page.length ? (page.at(-1)?.id ?? null) : null;
  // A control character uses six JSON bytes: reserve the largest accepted ID.
  const fits = (value: R) =>
    Buffer.byteLength(JSON.stringify(mcpToolResponse("\u0000".repeat(MCP_ID_LIMIT), value))) <=
    MCP_RESPONSE_LIMIT;
  let page: T[] = [];
  let value = response(page, next(page));
  if (!fits(value)) throw new ControlError("capacity");
  for (const row of rows.slice(start, start + maximum)) {
    const candidate = [...page, row];
    const proposed = response(candidate, next(candidate));
    if (!fits(proposed)) {
      if (!page.length) throw new ControlError("capacity");
      break;
    }
    page = candidate;
    value = proposed;
  }
  return value;
}
const envelope = { untrusted: true, notice: BOARD_NOTICE } as const;

/** Main-owned local history. No live transport, agent, terminal or child dependencies. */
export class MessageBoard {
  private data: Data = { version: 1, threads: [], posts: [], receipts: [] };
  private failed = false;
  private childWrites: Promise<unknown> = Promise.resolve();
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly save: (data: unknown) => Promise<void>,
    private readonly repositories: () => BoardRepository[],
    private readonly changed: () => void = () => {},
    private readonly limits = { bytes: LIMIT, receipts: 65536 },
  ) {}
  static async open(
    directory: string,
    repositories: () => BoardRepository[],
    changed: () => void,
  ): Promise<MessageBoard> {
    const board = new MessageBoard(
      (data) => atomicPrivate(directory, "board.json", data),
      repositories,
      changed,
    );
    const path = join(directory, "board.json");
    try {
      await lstat(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return board;
      throw new ControlError("unavailable");
    }
    await verifyPrivate(path, false);
    const expected = await lstat(path);
    const file = await open(
      path,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > LIMIT ||
        info.ino !== expected.ino ||
        info.dev !== expected.dev
      )
        throw new ControlError("unavailable");
      const bytes = Buffer.alloc(info.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await file.read(bytes, size, bytes.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size !== info.size) throw new ControlError("unavailable");
      board.restore(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))),
      );
    } catch {
      throw new ControlError("unavailable");
    } finally {
      await file.close();
    }
    await board.prune();
    return board;
  }
  private restore(value: unknown): void {
    const data = object(value);
    exact(data, ["version", "threads", "posts", "receipts"]);
    if (
      data["version"] !== 1 ||
      !Array.isArray(data["threads"]) ||
      !Array.isArray(data["posts"]) ||
      !Array.isArray(data["receipts"])
    )
      throw new ControlError("unavailable");
    const timestamp = (value: unknown) => {
      if (
        typeof value !== "string" ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value
      )
        throw new ControlError("unavailable");
      return value;
    };
    const threads = data["threads"].map((value: unknown): MessageThread => {
      const row = object(value);
      exact(row, ["id", "title", "repository", "to", "state", "createdAt", "updatedAt", "child"]);
      const input = boardPost({
        to: row["to"],
        title: row["title"],
        kind: "fyi",
        text: "validate",
        idempotencyKey: "restore",
      });
      return {
        ...(row["child"] === undefined
          ? {}
          : {
              child: (() => {
                const child = object(row["child"]);
                exact(child, ["id", "worktreeId", "removedAt"]);
                return {
                  id: identifier(child["id"]),
                  worktreeId: identifier(child["worktreeId"]),
                  ...(child["removedAt"] === undefined
                    ? {}
                    : { removedAt: timestamp(child["removedAt"]) }),
                };
              })(),
            }),
        id: identifier(row["id"]),
        title: boardText(row["title"], 200),
        repository: identifier(row["repository"]),
        to: input.to ?? [],
        state: threadState(row["state"]),
        createdAt: timestamp(row["createdAt"]),
        updatedAt: timestamp(row["updatedAt"]),
      };
    });
    const posts = data["posts"].map((value: unknown): MessagePost => {
      const row = object(value);
      exact(row, ["id", "thread", "author", "kind", "text", "links", "timestamp"]);
      const author = this.author(row["author"]);
      const thread = identifier(row["thread"]);
      if (!threads.some((row) => row.id === thread)) throw new ControlError("unavailable");
      return {
        id: identifier(row["id"]),
        thread,
        author,
        kind: postKind(row["kind"]),
        text: boardText(row["text"]),
        links: boardLinks(row["links"]),
        timestamp: timestamp(row["timestamp"]),
      };
    });
    const receipts = data["receipts"].map((value: unknown): Receipt => {
      const row = object(value);
      exact(row, ["scope", "key", "hash", "result"]);
      const result = object(row["result"]);
      exact(result, ["thread", "post"]);
      return {
        scope: boardText(row["scope"], 512),
        key: identifier(row["key"]),
        hash: identifier(row["hash"]),
        result: {
          thread: identifier(result["thread"]),
          post: result["post"] === null ? null : identifier(result["post"]),
        },
      };
    });
    if (
      new Set(threads.map((row) => row.id)).size !== threads.length ||
      new Set(posts.map((row) => row.id)).size !== posts.length ||
      new Set(receipts.map((row) => `${row.scope}:${row.key}`)).size !== receipts.length
    )
      throw new ControlError("unavailable");
    this.data = { version: 1, threads, posts, receipts };
  }
  private author(value: unknown): MessagePost["author"] {
    if (value === "human") return value;
    if (typeof value !== "string" || !value.startsWith("orchestrator:"))
      throw new ControlError("invalid_request");
    return `orchestrator:${identifier(value.slice(13))}`;
  }
  private visible(thread: MessageThread, repository?: string): boolean {
    return (
      !(
        thread.child?.removedAt &&
        Date.now() - Date.parse(thread.child.removedAt) >= CHILD_RETENTION
      ) &&
      (repository === undefined ||
        thread.repository === repository ||
        thread.to.includes(repository))
    );
  }
  private thread(id: string, repository?: string): MessageThread {
    const thread = this.data.threads.find((row) => row.id === id && this.visible(row, repository));
    if (!thread) throw new ControlError("not_found");
    return thread;
  }
  threads(value: unknown, repository?: string): BoardThreads {
    const input = object(value);
    exact(input, ["repository", "state", "after", "category"]);
    const category = input["category"];
    if (category !== undefined && category !== "children" && category !== "topics")
      throw new ControlError("invalid_request");
    const filter = input["repository"] === undefined ? undefined : identifier(input["repository"]);
    const state = input["state"] === undefined ? undefined : threadState(input["state"]);
    const rows = this.data.threads.filter(
      (row) =>
        this.visible(row, repository) &&
        this.visible(row, filter) &&
        (state === undefined || row.state === state) &&
        (category === undefined || (category === "children") === (row.child !== undefined)),
    );
    const after = input["after"] === undefined ? undefined : identifier(input["after"]);
    const start = after === undefined ? 0 : rows.findIndex((row) => row.id === after) + 1;
    if (after !== undefined && start === 0) throw new ControlError("not_found");
    const repositories = this.repositories().map((row) => ({ ...row }));
    return structuredClone(
      pageRows(rows, start, 100, (threads, next) => ({
        ...envelope,
        repositories,
        threads,
        next,
      })),
    );
  }
  read(value: unknown, repository?: string): BoardRead {
    const input = object(value);
    exact(input, ["thread", "after"]);
    const thread = this.thread(identifier(input["thread"]), repository);
    const rows = this.data.posts.filter((row) => row.thread === thread.id);
    const after = input["after"] === undefined ? undefined : identifier(input["after"]);
    const start = after === undefined ? 0 : rows.findIndex((row) => row.id === after) + 1;
    if (after !== undefined && start === 0) throw new ControlError("not_found");
    return structuredClone(
      pageRows(rows, start, 8, (posts, next) => ({
        ...envelope,
        thread,
        posts,
        next,
      })),
    );
  }
  /** Posts by other authors in threads addressed to this repository; metadata only. */
  event(repository: string): string {
    const addressed = new Set(
      this.data.threads
        .filter((thread) => this.visible(thread, repository))
        .map((thread) => thread.id),
    );
    return hash(
      JSON.stringify(
        this.data.posts
          .filter(
            (post) => addressed.has(post.thread) && post.author !== `orchestrator:${repository}`,
          )
          .map((post) => post.id),
      ),
    );
  }
  /** Main-only append seam for future app-owned producers. Never exposed as caller-selected identity. */
  append(
    author: MessagePost["author"],
    scope: string,
    value: unknown,
    active: () => void = () => {},
    child?: MessageThread["child"],
  ): Promise<BoardMutation> {
    const input = boardPost(value);
    const identity = this.author(author);
    const repository = identity === "human" ? undefined : identity.slice(13);
    return this.mutate(scope, input.idempotencyKey, [identity, input], active, (data) => {
      const now = new Date().toISOString();
      let thread: MessageThread;
      if (input.thread !== undefined) {
        thread = structuredClone(this.thread(input.thread, repository));
        if (thread.child && identity !== "human" && child === undefined)
          throw new ControlError("forbidden");
        if (thread.state === "resolved" && child === undefined) throw new ControlError("conflict");
      } else {
        if (!repository || !input.to || !input.title) throw new ControlError("invalid_request");
        const open = this.repositories().map((row) => row.id);
        if (!open.includes(repository) || input.to.some((id) => !open.includes(id)))
          throw new ControlError("not_found");
        thread = {
          id: randomUUID(),
          title: input.title,
          repository,
          to: [...input.to],
          state: "open",
          createdAt: now,
          updatedAt: now,
        };
      }
      if (child) thread.child = { ...child };
      const post: MessagePost = {
        id: randomUUID(),
        thread: thread.id,
        author: identity,
        kind: input.kind,
        text: input.text,
        links: [...input.links],
        timestamp: now,
      };
      thread.updatedAt = now;
      thread.state = child
        ? thread.state
        : identity !== "human" &&
            (input.kind === "decision-needed" || thread.state === "waiting-human")
          ? "waiting-human"
          : identity === "human" || input.kind === "request"
            ? "waiting-repo"
            : "open";
      const index = data.threads.findIndex((row) => row.id === thread.id);
      if (index < 0) data.threads.push(thread);
      else data.threads[index] = thread;
      data.posts.push(post);
      return { thread: thread.id, post: post.id };
    });
  }
  resolve(
    scope: string,
    value: unknown,
    repository?: string,
    active: () => void = () => {},
  ): Promise<BoardMutation> {
    const input = boardResolve(value);
    return this.mutate(scope, input.idempotencyKey, ["resolve", input], active, (data) => {
      const thread = this.thread(input.thread, repository);
      if (thread.child && repository !== undefined) throw new ControlError("forbidden");
      const index = data.threads.findIndex((row) => row.id === thread.id);
      data.threads[index] = { ...thread, state: "resolved", updatedAt: new Date().toISOString() };
      return { thread: thread.id, post: null };
    });
  }
  /** Structured main-owned events only. The transport never receives this capability. */
  childEvent(
    repository: string,
    child: NonNullable<MessageThread["child"]>,
    title: string,
    event: string,
    content: unknown,
    key: string,
    links: string[] = [],
  ): Promise<void> {
    // Escape controls/format characters as visible data, then bound at a code point boundary.
    const visible = (text: string) =>
      text.replace(
        /[\p{Cc}\p{Cf}\p{Cs}]/gu,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
    const raw = visible(`${event} · ${JSON.stringify(content)}`);
    const bounded = (text: string, bytes: number) => {
      if (Buffer.byteLength(text) <= bytes) return text;
      let result = "";
      for (const char of text) {
        if (Buffer.byteLength(result + char + " ⟨truncated⟩") > bytes) break;
        result += char;
      }
      return result + " ⟨truncated⟩";
    };
    const text = bounded(raw, 8192);
    const task = this.childWrites
      .catch(() => undefined)
      .then(async () => {
        const thread = this.data.threads.find((row) => row.child?.id === child.id);
        await this.append(
          `orchestrator:${repository}`,
          `child:${child.id}`,
          {
            ...(thread
              ? { thread: thread.id }
              : {
                  title: bounded(visible(title.trim() ? title : child.id), 200),
                  to: [repository],
                }),
            kind: "fyi",
            text,
            links,
            idempotencyKey: key,
          },
          () => {},
          { ...thread?.child, ...child },
        );
      });
    this.childWrites = task;
    // Observe asynchronous lifecycle writes without exposing any post content in diagnostics.
    void task.catch(() => {
      console.error("Child board recording unavailable");
    });
    return task;
  }
  flushChildren(): Promise<unknown> {
    return this.childWrites;
  }
  childThreads(): MessageThread[] {
    return structuredClone(this.data.threads.filter((row) => row.child));
  }
  /** No receipt is needed: the immutable timestamp makes successful removal idempotent. */
  worktreeRemoved(worktreeId: string, timestamp: string): Promise<void> {
    const task = this.childWrites
      .catch(() => undefined)
      .then(async () => {
        const write = this.writes.then(async () => {
          if (this.failed) throw new ControlError("unavailable");
          const next = structuredClone(this.data);
          let changed = false;
          for (const thread of next.threads) {
            if (thread.child?.worktreeId !== worktreeId || thread.child.removedAt) continue;
            this.markRemoved(next, thread, timestamp);
            changed = true;
          }
          if (!changed) return;
          try {
            await this.save(next);
          } catch {
            this.failed = true;
            throw new ControlError("unavailable");
          }
          this.data = next;
          this.changed();
        });
        this.writes = write.catch(() => undefined);
        await write;
      });
    this.childWrites = task;
    void task.catch(() => {
      console.error("Child board recording unavailable");
    });
    return task;
  }
  private markRemoved(data: Data, thread: MessageThread, timestamp: string): void {
    if (!thread.child) return;
    thread.child.removedAt = timestamp;
    thread.updatedAt = timestamp;
    data.posts.push({
      id: randomUUID(),
      thread: thread.id,
      author: `orchestrator:${thread.repository}`,
      kind: "fyi",
      text: 'worktree removal · {"status":"succeeded"}',
      links: [],
      timestamp,
    });
  }
  /** Reserve the complete final post and expiry metadata before accepting ordinary writes. */
  private reservedBytes(data: Data): number {
    const reserved = structuredClone(data);
    for (const thread of reserved.threads) {
      if (thread.child && !thread.child.removedAt)
        this.markRemoved(reserved, thread, "2000-01-01T00:00:00.000Z");
    }
    return Buffer.byteLength(JSON.stringify(reserved));
  }
  private pruneData(data: Data): boolean {
    const expired = new Set(
      data.threads
        .filter(
          (row) =>
            row.child?.removedAt && Date.now() - Date.parse(row.child.removedAt) >= CHILD_RETENTION,
        )
        .map((row) => row.id),
    );
    data.threads = data.threads.filter((row) => !expired.has(row.id));
    data.posts = data.posts.filter((row) => !expired.has(row.thread));
    data.receipts = data.receipts.filter((row) => !expired.has(row.result.thread));
    return expired.size > 0;
  }
  async prune(): Promise<void> {
    const task = this.writes.then(async () => {
      const next = structuredClone(this.data);
      if (!this.pruneData(next)) return;
      if (this.failed) throw new ControlError("unavailable");
      try {
        await this.save(next);
      } catch {
        this.failed = true;
        throw new ControlError("unavailable");
      }
      this.data = next;
    });
    this.writes = task.catch(() => undefined);
    await task;
  }
  private mutate(
    scope: string,
    key: string,
    input: unknown,
    active: () => void,
    change: (data: Data) => BoardMutation,
  ): Promise<BoardMutation> {
    boardText(scope, 512);
    const fingerprint = hash(JSON.stringify(input));
    const task = this.writes.then(async () => {
      active();
      if (this.failed) throw new ControlError("unavailable");
      const prior = this.data.receipts.find((row) => row.scope === scope && row.key === hash(key));
      if (prior) {
        if (prior.hash !== fingerprint) throw new ControlError("conflict");
        return { ...prior.result };
      }
      const next = structuredClone(this.data);
      this.pruneData(next);
      if (next.receipts.length >= this.limits.receipts) throw new ControlError("capacity");
      const result = change(next);
      next.receipts.push({ scope, key: hash(key), hash: fingerprint, result });
      if (this.reservedBytes(next) > this.limits.bytes) throw new ControlError("capacity");
      active();
      try {
        await this.save(next);
      } catch {
        // A failed sync may follow a successful rename. Refuse further writes until
        // validated restart recovery, rather than overwriting an ambiguous append.
        this.failed = true;
        throw new ControlError("unavailable");
      }
      this.data = next;
      this.changed();
      return { ...result };
    });
    this.writes = task.catch(() => undefined);
    return task;
  }
}
