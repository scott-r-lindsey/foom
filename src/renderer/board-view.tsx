import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, RefObject } from "react";
import type { BoardSource } from "./board-source.d";
import type { BoardRow } from "./board.d";
import { light, nextWaiting, waitTime } from "./board";

function lightStyle(row: BoardRow): CSSProperties & { "--light-opacity": number } {
  return { "--light-opacity": light(row).opacity };
}

export function Board({
  source,
  dialogRef,
}: {
  source: BoardSource;
  dialogRef: RefObject<HTMLDialogElement | null>;
}) {
  const rows = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const [selected, setSelected] = useState(rows[0]?.id);
  const [opened, setOpened] = useState<{ id: string }>();
  const [peek, setPeek] = useState<string>();
  const [now, setNow] = useState(Date.now);
  const buttonsRef = useRef(new Map<string, HTMLButtonElement>());
  const terminalRef = useRef<HTMLElement>(null);
  const openRow = rows.find((row) => row.id === opened?.id);
  const peekRow = rows.find((row) => row.id === peek);
  const waiting = rows.filter((row) => row.state === "needs_input").length;
  const groups = new Map<string, BoardRow[]>();
  for (const row of rows) {
    const group = groups.get(row.repository) ?? [];
    group.push(row);
    groups.set(row.repository, group);
  }
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (dialogRef.current?.open) setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [dialogRef]);
  useEffect(
    () =>
      source.subscribeActivity((id, rate) => {
        const row = source.getSnapshot().find((item) => item.id === id);
        if (row)
          buttonsRef.current
            .get(id)
            ?.style.setProperty("--light-opacity", String(light({ ...row, rate }).opacity));
      }),
    [source],
  );
  useLayoutEffect(() => {
    if (opened) terminalRef.current?.focus();
  }, [opened]);
  const hide = () => {
    setOpened(undefined);
    setPeek(undefined);
    if (selected) buttonsRef.current.get(selected)?.focus();
  };
  const open = (row: BoardRow) => {
    setSelected(row.id);
    setOpened({ id: row.id });
    setPeek(undefined);
    source.markSeen(row.id);
  };
  const resolve = (reason: string) => {
    if (!openRow || openRow.state !== "needs_input") return;
    source.resolve(openRow.id, reason);
    hide();
  };
  return (
    <dialog
      ref={dialogRef}
      className="board-dialog"
      aria-label="Sample board"
      onCancel={(event) => {
        if (opened || peek) {
          event.preventDefault();
          hide();
        }
      }}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === "Escape" && (opened || peek)) {
          event.preventDefault();
          hide();
        } else if (event.key.toLowerCase() === "n") {
          event.preventDefault();
          const next = nextWaiting(rows);
          if (next) open(next);
        } else if (!opened && selected) {
          const index = rows.findIndex((row) => row.id === selected);
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const next =
              rows[(index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length];
            if (next) buttonsRef.current.get(next.id)?.focus();
          } else if (event.key.toLowerCase() === "p") {
            event.preventDefault();
            setPeek(peek ? undefined : selected);
          }
        }
      }}
    >
      <div className="board-top">
        <div>
          <h1>Mission control</h1>
          <p>Sample board · Simulated sessions</p>
        </div>
        <button
          type="button"
          data-close=""
          onClick={() => {
            dialogRef.current?.close();
          }}
        >
          Return to shell
        </button>
      </div>
      <p className="board-help">↑ ↓ select · P peek · Enter open · Esc hide · N next waiting</p>
      <div className="board-list">
        {Array.from(groups, ([repository, group]) => (
          <section key={repository}>
            <h2>{repository}</h2>
            {group.map((row) => (
              <button
                key={row.id}
                type="button"
                className="board-row"
                data-state={row.state}
                tabIndex={row.id === selected ? 0 : -1}
                aria-current={row.id === selected}
                style={lightStyle(row)}
                ref={(element) => {
                  if (element) {
                    buttonsRef.current.set(row.id, element);
                  } else buttonsRef.current.delete(row.id);
                }}
                onFocus={() => {
                  setSelected(row.id);
                }}
                onClick={() => {
                  open(row);
                }}
                onMouseEnter={() => {
                  if (!opened) setPeek(row.id);
                }}
                onMouseLeave={() => {
                  setPeek(undefined);
                }}
              >
                <span className="board-light" aria-hidden="true" />
                <span className="board-branch">{row.branch}</span>
                <span className="board-agent">{row.agent}</span>
                <span className="board-state">{light(row).label}</span>
                <span className="board-wait">{waitTime(row, now)}</span>
                <span className="board-reason">{row.reason}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
      <aside className="board-peek" aria-label="Terminal peek" hidden={!peekRow}>
        <h2>{peekRow && `${peekRow.agent} · ${peekRow.branch}`}</h2>
        <pre>{peekRow?.tail.join("\n")}</pre>
      </aside>
      <section
        className="board-terminal"
        aria-label="Sample terminal"
        tabIndex={-1}
        hidden={!openRow}
        ref={terminalRef}
      >
        <button type="button" data-hide="" onClick={hide}>
          Hide terminal
        </button>
        <h2>{openRow && `${openRow.agent} · ${openRow.branch}`}</h2>
        <pre>{openRow?.tail.join("\n")}</pre>
        <p>Sample output. No commands are executed.</p>
        <button
          type="button"
          data-reply=""
          disabled={openRow?.state !== "needs_input"}
          onClick={() => {
            resolve("Sample reply sent");
          }}
        >
          Simulate reply
        </button>
        <button
          type="button"
          data-dismiss=""
          disabled={openRow?.state !== "needs_input"}
          onClick={() => {
            resolve("Not attention · dismissed");
          }}
        >
          Not attention
        </button>
      </section>
      <p className="board-summary" role="status">
        {waiting
          ? `${String(waiting)} ${waiting === 1 ? "session needs" : "sessions need"} you.`
          : "Nothing needs you. Yet."}
      </p>
    </dialog>
  );
}
