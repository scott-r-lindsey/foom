import { WorktreeDialog } from "./worktree-dialog";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CSSProperties } from "react";
import type { BoardSource } from "./board-source.d";
import type { BoardRow } from "./board.d";
import { groupRows, light, nextWaiting, waitTime } from "./board";

function lightStyle(row: BoardRow): CSSProperties & { "--light-opacity": number } {
  return { "--light-opacity": light(row).opacity };
}

function ShellPanel({
  source,
  onHide,
  onRestart,
}: {
  source: NonNullable<BoardSource["shell"]>;
  onHide: () => void;
  onRestart: () => void;
}) {
  const view = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const disposeRef = useRef<() => void>(undefined);
  const mount = useCallback(
    (element: HTMLElement | null) => {
      if (element) disposeRef.current = source.mount(element, onHide);
      else disposeRef.current?.();
    },
    [source, onHide],
  );
  return (
    <section className="shell-panel" aria-label="Shell terminal">
      <div className="terminal-toolbar">
        <span id="status" role="status">
          {view.status}
        </span>
        <button
          id="toggle-terminal"
          disabled={view.toggleDisabled}
          aria-controls="terminal"
          aria-expanded={view.visible}
          onClick={() => {
            if (view.visible) onHide();
            else void source.toggle();
          }}
        >
          {view.toggleLabel}
        </button>
        <button
          id="restart"
          disabled={view.restartDisabled}
          onClick={() => {
            onRestart();
          }}
        >
          Restart shell
        </button>
      </div>
      <div id="terminal" aria-label="Terminal" ref={mount} />
    </section>
  );
}

export function Board({
  source,
  inactive = false,
  onPreflight,
}: {
  source: BoardSource;
  /** Preflight is covering the board; it stays mounted so terminals keep running. */
  inactive?: boolean;
  onPreflight?: () => void;
}) {
  const rows = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const [launching, setLaunching] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [selection, setSelection] = useState(rows[0]?.id);
  const selected = rows.some((row) => row.id === selection) ? selection : rows[0]?.id;
  const [opened, setOpened] = useState<{ id: string; kind: BoardRow["kind"] }>();
  const [peek, setPeek] = useState<{ id: string; keyboard: boolean }>();
  const [feedbackError, setFeedbackError] = useState("");
  const [tail, setTail] = useState<readonly string[]>([]);
  const buttonsRef = useRef(new Map<string, HTMLButtonElement>());
  const terminalRef = useRef<HTMLElement>(null);
  const restoreRowFocusRef = useRef(false);
  const openRow =
    rows.find((row) => row.id === opened?.id) ??
    (opened?.kind === "shell"
      ? rows.find((row) => row.kind === "shell" && !row.managed)
      : undefined);
  const openedId = openRow?.kind === "sample" ? undefined : openRow?.id;
  const peekRow = rows.find((row) => row.id === peek?.id);
  const waiting = rows.filter((row) => row.state === "needs_input").length;
  const groups = groupRows(rows);
  const hide = useCallback(() => {
    void source.shell?.hide();
    restoreRowFocusRef.current = true;
    setOpened(undefined);
    setPeek(undefined);
  }, [source]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const row of source.getSnapshot()) {
        const element = buttonsRef.current.get(row.id)?.querySelector(".board-wait");
        if (element) element.textContent = waitTime(row, Date.now());
      }
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [source]);
  useEffect(
    () =>
      source.subscribeActivity((batch) => {
        for (const { id, rate } of batch) {
          const row = source.getSnapshot().find((item) => item.id === id);
          if (row)
            buttonsRef.current
              .get(id)
              ?.querySelector<HTMLElement>(".board-light")
              ?.style.setProperty("--light-opacity", String(light({ ...row, rate }).opacity));
        }
      }),
    [source],
  );
  const tailId = peek?.id ?? (openRow?.kind === "sample" ? openRow.id : undefined);
  useEffect(() => {
    let current = true;
    if (tailId) {
      void source.tail(tailId).then(
        (lines) => {
          if (current) setTail(lines);
        },
        () => {
          if (current) setTail(["Unable to read terminal output."]);
        },
      );
    }
    return () => {
      current = false;
    };
  }, [source, tailId, opened, peek]);
  useLayoutEffect(() => {
    if (opened) {
      terminalRef.current?.focus();
      if (openedId) void source.shell?.open(openedId);
    } else if (restoreRowFocusRef.current) {
      restoreRowFocusRef.current = false;
      if (selected) buttonsRef.current.get(selected)?.focus();
    }
  }, [opened, openedId, selected, source]);
  const focusedInitialRowRef = useRef(false);
  useLayoutEffect(() => {
    if (!focusedInitialRowRef.current && rows.length) {
      focusedInitialRowRef.current = true;
      buttonsRef.current.values().next().value?.focus();
    }
  }, [rows]);
  const wasInactiveRef = useRef(inactive);
  useLayoutEffect(() => {
    // Coming back from preflight: return focus to the row the user left.
    if (wasInactiveRef.current && !inactive && selected) buttonsRef.current.get(selected)?.focus();
    wasInactiveRef.current = inactive;
  }, [inactive, selected]);
  const open = (row: BoardRow) => {
    setFeedbackError("");
    setSelection(row.id);
    setOpened({ id: row.id, kind: row.kind });
    setPeek(undefined);
    setTail([]);
    source.markSeen(row.id);
  };
  return (
    <main
      className="board-home"
      aria-label="Board"
      hidden={inactive}
      inert={inactive}
      onKeyDown={(event) => {
        if (launching) return;
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === "Escape" && (opened || peek)) {
          event.preventDefault();
          hide();
        } else if (openRow && openRow.kind !== "sample") {
          // Every printable key belongs to the shell while its view is open.
          return;
        } else if (event.key.toLowerCase() === "n") {
          event.preventDefault();
          const next = nextWaiting(rows);
          if (next) open(next);
        } else if (!opened && selected) {
          const ordered = Array.from(groups.values()).flat();
          const index = ordered.findIndex((row) => row.id === selected);
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const next =
              ordered[
                (index + (event.key === "ArrowDown" ? 1 : ordered.length - 1)) % ordered.length
              ];
            if (next) buttonsRef.current.get(next.id)?.focus();
          } else if (event.key.toLowerCase() === "p") {
            event.preventDefault();
            setTail([]);
            setPeek(
              peek?.keyboard && peek.id === selected ? undefined : { id: selected, keyboard: true },
            );
          }
        }
      }}
    >
      <header className="board-top">
        <h1 className="wordmark" aria-label="foom">
          <span aria-hidden="true">
            fo
            <span className="wordmark-hole" />m
          </span>
        </h1>
        <p className="board-summary" role="status">
          {waiting
            ? `${String(waiting)} ${waiting === 1 ? "session needs" : "sessions need"} you.`
            : "Nothing needs you. Yet."}
        </p>
        <span className="sample-label">
          {rows.some((row) => row.kind === "sample") && "Sample sessions"}
        </span>
        {source.shell && !rows.some((row) => row.kind === "shell" && !row.managed) && (
          <button
            type="button"
            onClick={() => {
              void source.shell?.restart();
            }}
          >
            Local shell
          </button>
        )}
        {source.worktrees && (
          <button
            type="button"
            onClick={() => {
              if (opened) hide();
              setLaunching(true);
            }}
          >
            New worktree
          </button>
        )}
        {onPreflight && (
          <button
            type="button"
            className="board-preflight"
            onClick={() => {
              // Hide an open terminal first so its view isn't measured while covered.
              if (opened) hide();
              onPreflight();
            }}
          >
            Preflight
          </button>
        )}
      </header>
      {launching && source.worktrees && (
        <WorktreeDialog
          source={source.worktrees}
          close={() => {
            setLaunching(false);
          }}
        />
      )}
      {removeError && <p role="alert">{removeError}</p>}
      <p className="board-help">↑ ↓ select · P peek · Enter open · Esc hide · N next waiting</p>
      <div className="board-workspace" data-open={Boolean(openRow)}>
        <div className="board-list" inert={Boolean(openRow)}>
          {rows.length === 0 && (
            <p className="board-empty">
              Nothing needs you. Yet.
              <br />
              No terminals in orbit.
            </p>
          )}
          {Array.from(groups, ([repository, group]) => (
            <section key={repository}>
              <h2>{repository}</h2>
              {group.map((row) => (
                <div
                  className="board-entry"
                  key={row.kind === "shell" && !row.managed ? "local-shell" : row.id}
                >
                  <button
                    type="button"
                    className="board-row"
                    data-kind={row.kind}
                    data-state={row.state}
                    tabIndex={row.id === selected ? 0 : -1}
                    aria-current={row.id === selected}
                    ref={(element) => {
                      if (element) buttonsRef.current.set(row.id, element);
                      else buttonsRef.current.delete(row.id);
                    }}
                    onFocus={() => {
                      setSelection(row.id);
                    }}
                    onClick={() => {
                      open(row);
                    }}
                    onMouseEnter={() => {
                      if (!opened && !peek?.keyboard) {
                        setTail([]);
                        setPeek({ id: row.id, keyboard: false });
                      }
                    }}
                    onMouseLeave={() => {
                      if (!peek?.keyboard) setPeek(undefined);
                    }}
                  >
                    <span className="board-light" style={lightStyle(row)} aria-hidden="true" />
                    <span className="board-branch">{row.branch}</span>
                    <span className="board-agent">{row.agent}</span>
                    <span className="board-state">{light(row).label}</span>
                    <span className="board-wait">{waitTime(row, Date.now())}</span>
                    <span className="board-reason">{row.reason}</span>
                  </button>
                  {row.managed && source.worktrees && (
                    <button
                      type="button"
                      className="worktree-remove"
                      aria-label={`Remove worktree ${row.branch}`}
                      onClick={() => {
                        setRemoveError("");
                        void source.worktrees?.remove(row.id).catch((error: unknown) => {
                          setRemoveError(
                            error instanceof Error ? error.message : "Unable to remove worktree.",
                          );
                        });
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </section>
          ))}
        </div>
        <section
          className="board-terminal"
          aria-label="Open terminal"
          tabIndex={-1}
          hidden={!openRow}
          ref={terminalRef}
        >
          <div className="terminal-title">
            <h2>{openRow && `${openRow.agent} · ${openRow.branch}`}</h2>
            <button type="button" data-hide="" onClick={hide}>
              Back to board · Esc
            </button>
          </div>
          {openRow?.state === "needs_input" && (
            <div className="terminal-toolbar">
              <span>{openRow.reason}</span>
              <button
                type="button"
                onClick={() => {
                  setFeedbackError("");
                  void Promise.resolve(source.resolve(openRow.id, "Not attention")).catch(() => {
                    setFeedbackError("Unable to record feedback. Try again.");
                  });
                }}
              >
                Not attention
              </button>
            </div>
          )}
          {feedbackError && <p role="alert">{feedbackError}</p>}
          <div className="sample-terminal" hidden={openRow?.kind !== "sample"}>
            <pre>{tail.join("\n")}</pre>
            <p>Sample output · read-only</p>
          </div>
          {/* Keep the controller mounted while hidden. The host retains all output. */}
          <div className="shell-slot" hidden={!openRow || openRow.kind === "sample"}>
            {source.shell && (
              <ShellPanel
                source={source.shell}
                onHide={hide}
                onRestart={() => {
                  void source.shell?.restart().then(() => {
                    const row = source.getSnapshot().find((entry) => entry.kind === "shell");
                    if (row) open(row);
                  });
                }}
              />
            )}
          </div>
        </section>
      </div>
      <aside className="board-peek" aria-label="Terminal peek" hidden={!peekRow}>
        <h2>{peekRow && `${peekRow.agent} · ${peekRow.branch}`}</h2>
        <pre>{tail.join("\n")}</pre>
      </aside>
    </main>
  );
}
