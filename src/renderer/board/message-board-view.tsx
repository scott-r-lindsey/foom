import { useEffect, useRef, useState } from "react";
import type {
  BoardRead,
  BoardThreads,
  MessageBoardApi,
  MessagePost,
  ThreadState,
} from "../../shared/message-board";
import { boardText } from "../../shared/message-board-validation";
import { ActionError, useBackgroundErrors } from "./error-presentation";

const states: Record<ThreadState, string> = {
  open: "Open",
  "waiting-repo": "Waiting for repository",
  "waiting-human": "Decision needed",
  resolved: "Resolved",
};
export function MessageBoardPanel({
  api,
  subscribe,
  close,
}: {
  api: MessageBoardApi;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState<BoardThreads>();
  const [thread, setThread] = useState<string>();
  const [detail, setDetail] = useState<BoardRead>();
  const [revision, setRevision] = useState(0);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { report, clear } = useBackgroundErrors();
  const filterRef = useRef<HTMLSelectElement>(null);
  const pendingRef = useRef<{ key: string; thread: string; text: string } | undefined>(undefined);
  const resolveKeyRef = useRef<{ key: string; thread: string } | undefined>(undefined);
  useEffect(() => {
    filterRef.current?.focus();
  }, []);
  useEffect(
    () =>
      subscribe(() => {
        setRevision((value) => value + 1);
      }),
    [subscribe],
  );
  useEffect(() => {
    let current = true;
    const load = async () => {
      let next = await api.threads(filter ? { repository: filter } : {});
      const threads = [...next.threads];
      while (current && next.next) {
        next = await api.threads({ ...(filter ? { repository: filter } : {}), after: next.next });
        threads.push(...next.threads);
      }
      if (current) {
        setPage({ ...next, threads });
        clear("message-board-read");
      }
    };
    void load().catch(() => {
      if (current) report("message-board-read", "Unable to read the board.");
    });
    return () => {
      current = false;
    };
  }, [api, filter, revision, report, clear]);
  useEffect(() => {
    if (!thread) return;
    let current = true;
    const load = async () => {
      let next = await api.read({ thread });
      const posts: MessagePost[] = [...next.posts];
      while (current && next.next) {
        next = await api.read({ thread, after: next.next });
        posts.push(...next.posts);
      }
      if (current) {
        setDetail({ ...next, posts });
        clear("message-thread-read");
      }
    };
    void load().catch(() => {
      if (current) report("message-thread-read", "Unable to read the thread.");
    });
    return () => {
      current = false;
    };
  }, [api, thread, revision, report, clear]);
  const name = (id: string) =>
    page?.repositories.find((repo) => repo.id === id)?.name ?? id.slice(0, 12);
  const selected = detail?.thread.id === thread ? detail : undefined;
  const post = async () => {
    if (!thread) return;
    setBusy(true);
    try {
      boardText(reply);
      const prior = pendingRef.current;
      const request =
        prior?.thread === thread && prior.text === reply
          ? prior
          : { thread, text: reply, key: crypto.randomUUID() };
      pendingRef.current = request;
      await api.post({
        thread,
        kind: "answer",
        text: reply,
        links: [],
        idempotencyKey: request.key,
      });
      pendingRef.current = undefined;
      setReply("");
      setRevision((value) => value + 1);
    } catch {
      setError("Unable to post reply.");
    } finally {
      setBusy(false);
    }
  };
  const resolve = async () => {
    if (!thread) return;
    setBusy(true);
    try {
      const request =
        resolveKeyRef.current?.thread === thread
          ? resolveKeyRef.current
          : { thread, key: crypto.randomUUID() };
      resolveKeyRef.current = request;
      await api.resolve({ thread, idempotencyKey: request.key });
      resolveKeyRef.current = undefined;
      setRevision((value) => value + 1);
    } catch {
      setError("Unable to resolve thread.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="message-board"
      aria-label="Message board"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <header>
        <h1>Board</h1>
        <button type="button" onClick={close}>
          Close board
        </button>
      </header>
      <div className="message-board-columns">
        <nav className="message-thread-list" aria-label="Threads">
          <label>
            Repository{" "}
            <select
              ref={filterRef}
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
              }}
            >
              <option value="">All repositories</option>
              {page?.repositories.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
          </label>
          {page?.threads.length === 0 && <p>No threads</p>}
          {page?.threads.map((row) => (
            <button
              type="button"
              key={row.id}
              aria-pressed={thread === row.id}
              data-decision={row.state === "waiting-human"}
              onClick={() => {
                setThread(row.id);
                setReply("");
              }}
            >
              <strong>{row.title}</strong>
              <span>
                {name(row.repository)} → {row.to.map(name).join(", ")}
              </span>
              <span className="message-thread-state">
                {row.state === "waiting-human" ? "◇ " : ""}
                {states[row.state]}
              </span>
            </button>
          ))}
        </nav>
        {selected && (
          <section className="message-thread" aria-label={selected.thread.title}>
            <header>
              <div>
                <h2>{selected.thread.title}</h2>
                <span data-decision={selected.thread.state === "waiting-human"}>
                  {states[selected.thread.state]}
                </span>
              </div>
              <button
                type="button"
                disabled={busy || selected.thread.state === "resolved"}
                onClick={() => {
                  void resolve();
                }}
              >
                Mark resolved
              </button>
            </header>
            <ol>
              {selected.posts.map((post) => (
                <li
                  key={post.id}
                  data-decision={
                    post.kind === "decision-needed" && selected.thread.state === "waiting-human"
                  }
                >
                  <div className="message-post-meta">
                    <strong>{post.author === "human" ? "You" : name(post.author.slice(13))}</strong>
                    <span>{post.kind === "decision-needed" ? "◇ Decision needed" : post.kind}</span>
                    <time dateTime={post.timestamp}>
                      {new Date(post.timestamp).toLocaleString()}
                    </time>
                  </div>
                  <p>{post.text}</p>
                  {post.links.map((link, index) => (
                    <code key={`${String(index)}:${link}`}>{link}</code>
                  ))}
                </li>
              ))}
            </ol>
            {selected.thread.state !== "resolved" && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void post();
                }}
              >
                <label htmlFor="board-reply">Reply</label>
                <textarea
                  id="board-reply"
                  value={reply}
                  maxLength={8192}
                  disabled={busy}
                  onChange={(event) => {
                    setReply(event.target.value);
                  }}
                />
                <button type="submit" disabled={busy || !reply.trim()}>
                  Post reply
                </button>
              </form>
            )}
          </section>
        )}
      </div>
      {error && (
        <ActionError
          message={error}
          close={() => {
            setError("");
          }}
        />
      )}
    </section>
  );
}
