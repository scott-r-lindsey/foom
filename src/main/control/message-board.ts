import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivate, verifyPrivate } from "../../node-common/private-files";
import type {
  BoardDecision,
  BoardDecisions,
  BoardMutation,
  DecisionAddress,
  BoardRead,
  BoardRepository,
  BoardThreads,
  MessagePost,
  MessageThread,
  ThreadState,
} from "../../shared/message-board";
import {
  BOARD_NOTICE,
  OPEN_DECISION_LIMIT,
  boardAnswers,
  boardQuestions,
  decisionAddress,
  decisionAnswer,
  decisionHead,
  decisionSubject,
  boardLinks,
  boardPost,
  boardResolve,
  boardText,
  postKind,
  threadState,
} from "../../shared/message-board-validation";
import { ControlError, exact, identifier, object } from "../../shared/control-validation";
import { MCP_ID_LIMIT, MCP_RESPONSE_LIMIT, mcpToolResponse } from "../../node-common/mcp-response";

export type DecisionForge = (
  repository: string,
  pullRequest: number,
) => { headSha: string; checks?: NonNullable<BoardDecision["checks"]> } | undefined;

function addressKey({ post, index }: DecisionAddress): string {
  return `${post}:${String(index)}`;
}

function answeredPosts(posts: MessagePost[]): Set<string> {
  return new Set(posts.flatMap((post) => post.answers?.map(addressKey) ?? []));
}

function afterPost(state: ThreadState, post: MessagePost): ThreadState {
  if (post.author === "human") return "waiting-repo";
  if (post.kind === "decision-needed" || post.kind === "question" || state === "waiting-human")
    return "waiting-human";
  return post.kind === "request" ? "waiting-repo" : "open";
}

export interface BoardAnswerNotice {
  repository: string;
  post: string;
}

function recordStaleHeads(post: MessagePost, heads: Map<number, string>): void {
  if (!heads.size) return;
  post.stale = [...new Set([...(post.stale ?? []), ...heads.keys()])];
  post.staleHeads = { ...post.staleHeads, ...Object.fromEntries(heads) };
}

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
  private readonly observedStale = new Map<string, Map<number, string>>();
  private savingQuestion: { post: MessagePost; heads: Map<number, string> } | undefined;
  private childWrites: Promise<unknown> = Promise.resolve();
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly save: (data: unknown, beforeCommit?: () => void) => Promise<void>,
    private readonly repositories: () => BoardRepository[],
    private readonly changed: (answers?: readonly BoardAnswerNotice[]) => void = () => {},
    private readonly limits = { bytes: LIMIT, receipts: 65536 },
    private readonly forge: DecisionForge = () => undefined,
  ) {}
  static async open(
    directory: string,
    repositories: () => BoardRepository[],
    changed: (answers?: readonly BoardAnswerNotice[]) => void,
    forge?: DecisionForge,
  ): Promise<MessageBoard> {
    const board = new MessageBoard(
      (data, beforeCommit) => atomicPrivate(directory, "board.json", data, beforeCommit),
      repositories,
      changed,
      undefined,
      forge,
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
    this.data = parseMessageBoard(value);
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
    const questionThreads = new Map<string, MessagePost[]>();
    for (const post of this.data.posts) if (post.questions) questionThreads.set(post.thread, []);
    for (const post of this.data.posts) questionThreads.get(post.thread)?.push(post);
    const rows = this.data.threads
      .filter(
        (row) =>
          this.visible(row, repository) &&
          this.visible(row, filter) &&
          (category === undefined || (category === "children") === (row.child !== undefined)),
      )
      .map((thread) => this.displayThread(thread, questionThreads.get(thread.id)))
      .filter((row) => state === undefined || row.state === state);
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
    const answered = answeredPosts(this.data.posts);
    const rows = this.data.posts
      .filter((row) => row.thread === thread.id)
      .map((post) =>
        post.questions ? { ...post, decisions: this.project(post, thread, answered) } : post,
      );
    const after = input["after"] === undefined ? undefined : identifier(input["after"]);
    const start = after === undefined ? 0 : rows.findIndex((row) => row.id === after) + 1;
    if (after !== undefined && start === 0) throw new ControlError("not_found");
    return structuredClone(
      pageRows(rows, start, 8, (posts, next) => ({
        ...envelope,
        thread: this.displayThread(thread, rows),
        posts,
        next,
      })),
    );
  }
  private displayThread(thread: MessageThread, posts: MessagePost[] = []): MessageThread {
    if (thread.state === "resolved" || !posts.some((post) => post.questions)) return thread;
    const answered = answeredPosts(posts);
    if (
      posts.some((post) =>
        this.project(post, thread, answered).some(
          ({ status }) => status === "open" || status === "checking",
        ),
      )
    )
      return { ...thread, state: "waiting-human" };
    const state = posts.filter((post) => !post.questions).reduce<ThreadState>(afterPost, "open");
    return { ...thread, state };
  }

  private project(
    post: MessagePost,
    thread: MessageThread,
    answered: Set<string>,
  ): BoardDecision[] {
    const repository = post.author.slice(13);
    return (post.questions ?? []).map((question, index) => {
      const address = { post: post.id, index };
      const subject = question.subject;
      const current = subject && this.forge(repository, subject.pullRequest);
      const mismatch =
        subject && current && subject.headSha !== current.headSha ? current.headSha : undefined;
      const movedHead =
        mismatch ?? this.observedStale.get(post.id)?.get(index) ?? post.staleHeads?.[String(index)];
      const status = answered.has(addressKey(address))
        ? "answered"
        : post.withdrawn || thread.state === "resolved"
          ? "withdrawn"
          : post.stale?.includes(index) || movedHead
            ? "stale"
            : subject && !current
              ? "checking"
              : "open";
      return {
        ...address,
        repository,
        question,
        status,
        ...(status === "stale" && movedHead ? { movedHead } : {}),
        ...(current?.checks === undefined ? {} : { checks: current.checks }),
      };
    });
  }

  decisions(value: unknown): BoardDecisions {
    const input = object(value);
    exact(input, ["repository", "watch"]);
    const repository =
      input["repository"] === undefined ? undefined : identifier(input["repository"]);
    const watch = input["watch"];
    if (!Array.isArray(watch) || watch.length > OPEN_DECISION_LIMIT)
      throw new ControlError("invalid_request");
    const watched = new Set(watch.map((value: unknown) => addressKey(decisionAddress(value))));
    const counts = new Map<string, number>();
    const questions: BoardDecision[] = [];
    const answered = answeredPosts(this.data.posts);
    const threads = new Map(this.data.threads.map((thread) => [thread.id, thread]));
    for (const post of this.data.posts) {
      const thread = threads.get(post.thread);
      if (!post.questions || !thread) continue;
      for (const row of this.project(post, thread, answered)) {
        const open = row.status === "open" || row.status === "checking";
        if (open) counts.set(row.repository, (counts.get(row.repository) ?? 0) + 1);
        if ((open && repository === row.repository) || watched.has(addressKey(row)))
          questions.push(row);
      }
    }
    return structuredClone({ counts: Object.fromEntries(counts), questions });
  }

  pendingSubjects(): { repository: string; number: number }[] {
    const subjects = new Map<string, { repository: string; number: number }>();
    const answered = answeredPosts(this.data.posts);
    const threads = new Map(this.data.threads.map((thread) => [thread.id, thread]));
    for (const post of this.data.posts) {
      const thread = threads.get(post.thread);
      if (!post.questions || !thread) continue;
      for (const row of this.project(post, thread, answered)) {
        const subject = row.question.subject;
        if (subject && (row.status === "open" || row.status === "checking")) {
          const number = subject.pullRequest;
          subjects.set(`${row.repository}:${String(number)}`, {
            repository: row.repository,
            number,
          });
        }
      }
    }
    return [...subjects.values()];
  }

  preview(value: unknown) {
    const address = decisionAddress(value);
    const post = this.data.posts.find((post) => post.id === address.post);
    const preview = post?.questions?.[address.index]?.preview;
    if (!post || !preview) return undefined;
    return { ...preview, repository: post.author.slice(13), worktree: post.previewWorktree };
  }

  private observeSavingQuestion(): void {
    const pending = this.savingQuestion;
    if (!pending) return;
    const repository = pending.post.author.slice(13);
    for (const [index, { subject }] of (pending.post.questions ?? []).entries()) {
      if (!subject || pending.heads.has(index)) continue;
      const current = this.forge(repository, subject.pullRequest);
      if (current && current.headSha !== subject.headSha) pending.heads.set(index, current.headSha);
    }
  }

  /** Latch an observed head change immediately, then persist it through the board write queue. */
  observe(): void {
    this.observeSavingQuestion();
    const answered = answeredPosts(this.data.posts);
    const threads = new Map(this.data.threads.map((thread) => [thread.id, thread]));
    let changed = false;
    for (const post of this.data.posts) {
      const thread = threads.get(post.thread);
      if (!post.questions || !thread) continue;
      for (const row of this.project(post, thread, answered)) {
        if (row.status !== "stale" || !row.movedHead || post.staleHeads?.[String(row.index)])
          continue;
        const heads = this.observedStale.get(post.id) ?? new Map<number, string>();
        if (heads.has(row.index)) continue;
        heads.set(row.index, row.movedHead);
        this.observedStale.set(post.id, heads);
        changed = true;
      }
    }
    if (!changed) return;
    const task = this.writes.then(async () => {
      if (this.failed) return;
      const next = structuredClone(this.data);
      const observed = structuredClone(this.observedStale);
      for (const post of next.posts) {
        const known = observed.get(post.id);
        if (known) recordStaleHeads(post, known);
      }
      try {
        await this.save(next);
      } catch {
        this.failed = true;
        return;
      }
      this.data = next;
      for (const [id, indexes] of observed) {
        const pending = this.observedStale.get(id);
        for (const index of indexes.keys()) pending?.delete(index);
        if (!pending?.size) this.observedStale.delete(id);
      }
    });
    this.writes = task;
    this.changed();
  }

  answer(value: unknown): Promise<BoardMutation> {
    const input = boardAnswers(value);
    const notices: BoardAnswerNotice[] = [];
    const requireOpen = () => {
      const answered = answeredPosts(this.data.posts);
      for (const { post, index } of input.answers) {
        const source = this.data.posts.find((row) => row.id === post);
        if (!source?.questions) throw new ControlError("not_found");
        const row = this.project(source, this.thread(source.thread), answered)[index];
        if (!row || row.status !== "open") throw new ControlError("conflict");
      }
    };
    return this.mutate(
      "human",
      input.idempotencyKey,
      ["decisions", input],
      () => {},
      (data) => {
        const byQuestionPost = new Map<string, NonNullable<MessagePost["answers"]>>();
        for (const answer of input.answers) {
          const post = data.posts.find((post) => post.id === answer.post);
          const question = post?.questions?.[answer.index];
          if (!question) throw new ControlError("conflict");
          if (
            answer.option !== undefined &&
            !question.options.some(({ id }) => id === answer.option)
          )
            throw new ControlError("invalid_request");
          const batch = byQuestionPost.get(answer.post) ?? [];
          batch.push({
            ...answer,
            ...(question.subject ? { subject: question.subject } : {}),
          });
          byQuestionPost.set(answer.post, batch);
        }
        const timestamp = new Date().toISOString();
        let result: BoardMutation | undefined;
        for (const [parent, answers] of byQuestionPost) {
          const question = data.posts.find((post) => post.id === parent);
          const thread = data.threads.find((thread) => thread.id === question?.thread);
          if (!question || !thread) throw new ControlError("not_found");
          const id = randomUUID();
          data.posts.push({
            id,
            thread: thread.id,
            author: "human",
            kind: "answer",
            text: answers.length === 1 ? "Decision answered" : "Decisions answered",
            links: [],
            timestamp,
            answers,
          });
          notices.push({ repository: question.author.slice(13), post: id });
          thread.state = "waiting-repo";
          thread.updatedAt = timestamp;
          result ??= { thread: thread.id, post: id };
        }
        if (!result) throw new ControlError("invalid_request");
        return result;
      },
      { beforeCommit: requireOpen, notices },
    );
  }

  /** Posts by other authors and stale subjects in the repository’s threads. Metadata only. */
  event(repository: string): string {
    const addressed = new Set(
      this.data.threads
        .filter((thread) => this.visible(thread, repository))
        .map((thread) => thread.id),
    );
    const answered = answeredPosts(this.data.posts);
    const stale = this.data.posts.flatMap((post) => {
      if (!post.questions || !addressed.has(post.thread)) return [];
      return this.project(post, this.thread(post.thread), answered)
        .filter((row) => row.status === "stale")
        .map(addressKey);
    });
    return hash(
      JSON.stringify([
        ...this.data.posts
          .filter(
            (post) => addressed.has(post.thread) && post.author !== `orchestrator:${repository}`,
          )
          .map((post) => post.id),
        ...stale,
      ]),
    );
  }
  /** Main-only append seam for future app-owned producers. Never exposed as caller-selected identity. */
  append(
    author: MessagePost["author"],
    scope: string,
    value: unknown,
    active: () => void = () => {},
    child?: MessageThread["child"],
    previewWorktree?: string,
  ): Promise<BoardMutation> {
    const input = boardPost(value);
    const identity = boardAuthor(author);
    const repository = identity === "human" ? undefined : identity.slice(13);
    if (input.questions && (!repository || child)) throw new ControlError("forbidden");
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
      if (input.questions && repository) {
        const pending = this.decisions({ watch: [] }).counts[repository] ?? 0;
        if (pending + input.questions.length > OPEN_DECISION_LIMIT)
          throw new ControlError("capacity");
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
        ...(input.questions === undefined
          ? {}
          : {
              questions: input.questions,
              ...(previewWorktree && input.questions.some(({ preview }) => preview)
                ? { previewWorktree: identifier(previewWorktree) }
                : {}),
            }),
      };
      thread.updatedAt = now;
      if (!child) thread.state = afterPost(thread.state, post);
      const index = data.threads.findIndex((row) => row.id === thread.id);
      if (index < 0) data.threads.push(thread);
      else data.threads[index] = thread;
      data.posts.push(post);
      return { thread: thread.id, post: post.id, ...(post.questions ? { question: post } : {}) };
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
      if (input.post !== undefined) {
        if (!repository) throw new ControlError("forbidden");
        const post = data.posts.find((row) => row.id === input.post && row.thread === thread.id);
        if (!post?.questions) throw new ControlError("not_found");
        if (post.author !== `orchestrator:${repository}`) throw new ControlError("forbidden");
        const open = this.project(post, thread, answeredPosts(data.posts)).some(
          ({ status }) => status === "open" || status === "checking",
        );
        if (!open) throw new ControlError("conflict");
        post.withdrawn = true;
        return { thread: thread.id, post: post.id };
      }
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
  async flush(): Promise<void> {
    await this.flushChildren();
    await this.writes;
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
    for (const post of reserved.posts) {
      if (post.questions) {
        const heads = new Map<number, string>();
        for (const [index, { subject }] of post.questions.entries())
          if (subject) heads.set(index, "0".repeat(64));
        recordStaleHeads(post, heads);
      }
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
    change: (data: Data) => BoardMutation & { question?: MessagePost },
    answerEffects?: { beforeCommit: () => void; notices: BoardAnswerNotice[] },
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
      answerEffects?.beforeCommit();
      const { question, ...result } = change(next);
      next.receipts.push({ scope, key: hash(key), hash: fingerprint, result });
      if (this.reservedBytes(next) > this.limits.bytes) throw new ControlError("capacity");
      active();
      const commit = { refused: false };
      const check =
        answerEffects &&
        (() => {
          try {
            answerEffects.beforeCommit();
          } catch (error) {
            commit.refused = true;
            throw error;
          }
        });
      const saving = question && { post: question, heads: new Map<number, string>() };
      this.savingQuestion = saving;
      try {
        if (saving) {
          // A head can move while writing the snapshot or while syncing the rename.
          // Retry with each newly latched head before publishing the question.
          const retry = new Error("Decision head changed during save");
          let saved: number;
          this.observeSavingQuestion();
          do {
            recordStaleHeads(saving.post, saving.heads);
            saved = saving.heads.size;
            await this.save(next, () => {
              this.observeSavingQuestion();
              if (saved !== saving.heads.size) throw retry;
            }).catch((error: unknown) => {
              if (error !== retry) throw error;
            });
            this.observeSavingQuestion();
          } while (saved !== saving.heads.size);
        } else {
          await this.save(next, check);
        }
      } catch (error) {
        if (commit.refused) throw error;
        // A failed sync may follow a successful rename. Refuse further writes until
        // validated restart recovery, rather than overwriting an ambiguous append.
        this.failed = true;
        throw new ControlError("unavailable");
      } finally {
        this.savingQuestion = undefined;
      }
      this.data = next;
      this.changed(answerEffects?.notices);
      return { ...result };
    });
    this.writes = task.catch(() => undefined);
    return task;
  }
}

export function parseMessageBoard(value: unknown): Data {
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
    exact(row, [
      "id",
      "thread",
      "author",
      "kind",
      "text",
      "links",
      "timestamp",
      "questions",
      "withdrawn",
      "stale",
      "staleHeads",
      "previewWorktree",
      "answers",
    ]);
    const kind = postKind(row["kind"]);
    const question = kind === "question";
    if (
      question !== (row["questions"] !== undefined) ||
      (!question &&
        (row["withdrawn"] !== undefined ||
          row["stale"] !== undefined ||
          row["staleHeads"] !== undefined ||
          row["previewWorktree"] !== undefined)) ||
      (row["withdrawn"] !== undefined && row["withdrawn"] !== true) ||
      (row["answers"] !== undefined && (kind !== "answer" || row["author"] !== "human"))
    )
      throw new ControlError("unavailable");
    const questions = question ? boardQuestions(row["questions"]) : undefined;
    const stale: unknown = row["stale"];
    const staleIndexes = stale === undefined ? undefined : storedStale(stale, questions);
    const staleHeads =
      row["staleHeads"] === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(object(row["staleHeads"])).map(([index, value]) => {
              const number = Number(index);
              const head = decisionHead(value);
              if (
                String(number) !== index ||
                !staleIndexes?.includes(number) ||
                questions?.[number]?.subject?.headSha === head
              )
                throw new ControlError("unavailable");
              return [index, head];
            }),
          );
    const answers = row["answers"] === undefined ? undefined : storedAnswers(row["answers"]);
    const author = boardAuthor(row["author"]);
    const thread = identifier(row["thread"]);
    const owner = threads.find((row) => row.id === thread);
    if (
      !owner ||
      (question &&
        (author === "human" ||
          owner.child ||
          (owner.repository !== author.slice(13) && !owner.to.includes(author.slice(13)))))
    )
      throw new ControlError("unavailable");
    return {
      id: identifier(row["id"]),
      thread,
      author,
      kind,
      text: boardText(row["text"]),
      links: boardLinks(row["links"]),
      timestamp: timestamp(row["timestamp"]),
      ...(questions === undefined ? {} : { questions }),
      ...(row["withdrawn"] === true ? { withdrawn: true } : {}),
      ...(staleIndexes === undefined ? {} : { stale: staleIndexes }),
      ...(staleHeads === undefined ? {} : { staleHeads }),
      ...(row["previewWorktree"] === undefined
        ? {}
        : { previewWorktree: identifier(row["previewWorktree"]) }),
      ...(answers === undefined ? {} : { answers }),
    };
  });
  const priorPosts = new Map<string, MessagePost>();
  const answers = new Set<string>();
  for (const post of posts) {
    for (const answer of post.answers ?? []) {
      const source = priorPosts.get(answer.post);
      const question = source?.questions?.[answer.index];
      const key = addressKey(answer);
      if (
        !question ||
        source.thread !== post.thread ||
        answers.has(key) ||
        (answer.option !== undefined && !question.options.some(({ id }) => id === answer.option)) ||
        JSON.stringify(answer.subject) !== JSON.stringify(question.subject)
      )
        throw new ControlError("unavailable");
      answers.add(key);
    }
    priorPosts.set(post.id, post);
  }
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
  return { version: 1, threads, posts, receipts };
}
function storedStale(value: unknown, questions: MessagePost["questions"]): number[] {
  if (!Array.isArray(value) || !questions || value.length < 1 || value.length > questions.length)
    throw new ControlError("unavailable");
  const indexes = value.map((index: unknown) => {
    if (typeof index !== "number" || !Number.isInteger(index) || !questions[index]?.subject)
      throw new ControlError("unavailable");
    return index;
  });
  if (new Set(indexes).size !== indexes.length) throw new ControlError("unavailable");
  return indexes;
}

function storedAnswers(value: unknown): NonNullable<MessagePost["answers"]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4)
    throw new ControlError("unavailable");
  return value.map((value: unknown) => {
    const row = object(value);
    const { subject, ...choice } = row;
    return {
      ...decisionAnswer(choice),
      ...(subject === undefined ? {} : { subject: decisionSubject(subject) }),
    };
  });
}

function boardAuthor(value: unknown): MessagePost["author"] {
  if (value === "human") return value;
  if (typeof value !== "string" || !value.startsWith("orchestrator:"))
    throw new ControlError("invalid_request");
  return `orchestrator:${identifier(value.slice(13))}`;
}
