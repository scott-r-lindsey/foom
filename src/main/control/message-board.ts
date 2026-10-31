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
const LIMIT = 32 * 1024 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function pageRows<T>(rows: T[], start: number, maximum: number): T[] {
  const page: T[] = [];
  let bytes = 0;
  for (const row of rows.slice(start, start + maximum)) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (bytes + size > 128 * 1024) break;
    page.push(row);
    bytes += size;
  }
  return page;
}
const envelope = { untrusted: true, notice: BOARD_NOTICE } as const;

/** Main-owned local history. No transport, agent, terminal or child dependencies. */
export class MessageBoard {
  private data: Data = { version: 1, threads: [], posts: [], receipts: [] };
  private failed = false;
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
      exact(row, ["id", "title", "repository", "to", "state", "createdAt", "updatedAt"]);
      const input = boardPost({
        to: row["to"],
        title: row["title"],
        kind: "fyi",
        text: "validate",
        idempotencyKey: "restore",
      });
      return {
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
      repository === undefined || thread.repository === repository || thread.to.includes(repository)
    );
  }
  private thread(id: string, repository?: string): MessageThread {
    const thread = this.data.threads.find((row) => row.id === id && this.visible(row, repository));
    if (!thread) throw new ControlError("not_found");
    return thread;
  }
  threads(value: unknown, repository?: string): BoardThreads {
    const input = object(value);
    exact(input, ["repository", "state", "after"]);
    const filter = input["repository"] === undefined ? undefined : identifier(input["repository"]);
    const state = input["state"] === undefined ? undefined : threadState(input["state"]);
    const rows = this.data.threads.filter(
      (row) =>
        this.visible(row, repository) &&
        this.visible(row, filter) &&
        (state === undefined || row.state === state),
    );
    const after = input["after"] === undefined ? undefined : identifier(input["after"]);
    const start = after === undefined ? 0 : rows.findIndex((row) => row.id === after) + 1;
    if (after !== undefined && start === 0) throw new ControlError("not_found");
    const page = pageRows(rows, start, 100);
    return {
      ...envelope,
      repositories: this.repositories().map((row) => ({ ...row })),
      threads: structuredClone(page),
      next: rows.length > start + page.length ? (page.at(-1)?.id ?? null) : null,
    };
  }
  read(value: unknown, repository?: string): BoardRead {
    const input = object(value);
    exact(input, ["thread", "after"]);
    const thread = this.thread(identifier(input["thread"]), repository);
    const rows = this.data.posts.filter((row) => row.thread === thread.id);
    const after = input["after"] === undefined ? undefined : identifier(input["after"]);
    const start = after === undefined ? 0 : rows.findIndex((row) => row.id === after) + 1;
    if (after !== undefined && start === 0) throw new ControlError("not_found");
    const page = pageRows(rows, start, 8);
    return {
      ...envelope,
      thread: structuredClone(thread),
      posts: structuredClone(page),
      next: rows.length > start + page.length ? (page.at(-1)?.id ?? null) : null,
    };
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
  ): Promise<BoardMutation> {
    const input = boardPost(value);
    const identity = this.author(author);
    const repository = identity === "human" ? undefined : identity.slice(13);
    return this.mutate(scope, input.idempotencyKey, [identity, input], active, (data) => {
      const now = new Date().toISOString();
      let thread: MessageThread;
      if (input.thread !== undefined) {
        thread = structuredClone(this.thread(input.thread, repository));
        if (thread.state === "resolved") throw new ControlError("conflict");
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
      thread.state =
        identity !== "human" &&
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
      const index = data.threads.findIndex((row) => row.id === thread.id);
      data.threads[index] = { ...thread, state: "resolved", updatedAt: new Date().toISOString() };
      return { thread: thread.id, post: null };
    });
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
      if (this.data.receipts.length >= this.limits.receipts) throw new ControlError("capacity");
      const next = structuredClone(this.data);
      const result = change(next);
      next.receipts.push({ scope, key: hash(key), hash: fingerprint, result });
      if (Buffer.byteLength(JSON.stringify(next)) > this.limits.bytes)
        throw new ControlError("capacity");
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
