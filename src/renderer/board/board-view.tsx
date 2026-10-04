import { Sidebar, launcherActions } from "./sidebar-view";
import { readPreferences, writePreferences, renameSession } from "./sidebar-preferences";
import type { SidebarLocation } from "./sidebar.d";
import type { SidebarCommand } from "../../shared/workspace";
import type { LaunchOptions } from "./board-source.d";
import {
  sessionName,
  repositoryKey,
  worktreeKey,
  rowRepository,
  rowWorktree,
} from "./sidebar-model";
import { WorktreeDialog } from "./worktree-dialog";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import type { BoardSource } from "./board-source.d";
import type { BoardRow } from "./board.d";
import { light, nextWaiting, waitTime } from "./board";

function ShellPanel({
  source,
  onRestart,
  canRestart,
}: {
  source: NonNullable<BoardSource["shell"]>;
  onRestart: () => void;
  canRestart: boolean;
}) {
  const view = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const disposeRef = useRef<() => void>(undefined);
  const mount = useCallback(
    (element: HTMLElement | null) => {
      if (element) disposeRef.current = source.mount(element);
      else disposeRef.current?.();
    },
    [source],
  );
  return (
    <section className="shell-panel" aria-label="Shell terminal">
      <div className="terminal-toolbar">
        <span id="status" role="status">
          {view.status}
        </span>
        <button
          id="restart"
          hidden={!canRestart}
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
  onSettings,
  settingsView,
  onCloseSettings,
}: {
  source: BoardSource;
  /** Preflight is covering the board; it stays mounted so terminals keep running. */
  inactive?: boolean;
  onPreflight?: () => void;
  onSettings?: () => void;
  settingsView?: ReactNode;
  onCloseSettings?: () => void;
}) {
  const settingsOpen = Boolean(settingsView);
  const paneInactive = inactive || settingsOpen;
  const rows = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const [launching, setLaunching] = useState(false);
  const [launchRepository, setLaunchRepository] = useState<string>();
  const [location, setLocation] = useState<SidebarLocation>();
  const [preferences, setPreferences] = useState(() => readPreferences(localStorage));
  const revealRef = useRef<(row: BoardRow) => void>(undefined);
  const [options, setOptions] = useState<LaunchOptions>();
  useEffect(() => {
    let current = true;
    void source.worktrees?.load().then(
      (next) => {
        if (current) setOptions(next);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [source, inactive, settingsOpen]);
  const save = (next: typeof preferences) => {
    try {
      writePreferences(localStorage, next);
      setPreferences(next);
    } catch {
      setRemoveError("Unable to save sidebar preferences.");
    }
  };
  const newWorktree = (repository?: string) => {
    setLaunchRepository(repository);
    setLaunching(true);
  };
  const [removeError, setRemoveError] = useState("");
  const [selection, setSelection] = useState(rows[0]?.id);
  const selected = rows.some((row) => row.id === selection) ? selection : rows[0]?.id;
  const [displayed, setDisplayed] = useState<{ id: string; kind: BoardRow["kind"] }>();
  const [peek, setPeek] = useState<{ id: string }>();
  const [feedbackError, setFeedbackError] = useState("");
  const [tail, setTail] = useState<readonly string[]>([]);
  const buttonsRef = useRef(new Map<string, HTMLElement>());
  const terminalRef = useRef<HTMLElement>(null);
  const openRow =
    rows.find((row) => row.id === displayed?.id) ??
    (displayed?.kind === "shell"
      ? rows.find((row) => row.kind === "shell" && !row.managed)
      : undefined);
  const displayedId = openRow?.kind === "sample" ? undefined : openRow?.id;
  const peekRow = rows.find((row) => row.id === peek?.id);
  const sidebarRef = useRef<HTMLElement>(null);
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
  const tailId = peek?.id;
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
  }, [source, tailId, displayed, peek]);
  const selectedRef = useRef(selected);
  useLayoutEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  const wasInactiveRef = useRef(paneInactive);
  useLayoutEffect(() => {
    let current = true;
    const returning = wasInactiveRef.current;
    if (displayed && !paneInactive) {
      terminalRef.current?.focus();
      if (displayedId)
        void source.shell?.open(displayedId).then(() => {
          if (current && returning && selectedRef.current)
            buttonsRef.current.get(selectedRef.current)?.focus();
        });
    }
    if (paneInactive || !displayedId) void source.shell?.hide();
    return () => {
      current = false;
    };
  }, [displayed, displayedId, source, paneInactive]);
  const focusedInitialRowRef = useRef(false);
  useLayoutEffect(() => {
    if (!focusedInitialRowRef.current && rows.length) {
      focusedInitialRowRef.current = true;
      buttonsRef.current.values().next().value?.focus();
    }
  }, [rows]);
  useLayoutEffect(() => {
    // Coming back from setup: restore the row now and again after attachment settles.
    if (wasInactiveRef.current && !paneInactive && selected)
      buttonsRef.current.get(selected)?.focus();
    wasInactiveRef.current = paneInactive;
  }, [paneInactive, selected]);
  const open = useCallback(
    (row: BoardRow) => {
      setFeedbackError("");
      setSelection(row.id);
      setLocation(undefined);
      revealRef.current?.(row);
      setDisplayed({ id: row.id, kind: row.kind });
      setPeek(undefined);
      setTail([]);
      // Selecting a row asks for terminal input focus, rather than Escape restoration.
      wasInactiveRef.current = false;
      onCloseSettings?.();
      source.markSeen(row.id);
    },
    [source, onCloseSettings],
  );
  const command = (value: SidebarCommand) => {
    setRemoveError("");
    const before = new Set(source.getSnapshot().map((row) => row.id));
    void source
      .sidebarCommand?.(value)
      .then(() => {
        if (value.kind === "launch" || value.kind === "restart") {
          const created = source.getSnapshot().find((row) => !before.has(row.id));
          if (created) {
            open(created);
            const name = value.kind === "restart" ? preferences.names[value.id] : undefined;
            if (name) {
              const renamed = renameSession(preferences, created.id, name);
              save({
                ...renamed,
                expanded: {
                  ...renamed.expanded,
                  [repositoryKey(rowRepository(created))]: true,
                  [worktreeKey(rowWorktree(created))]: true,
                },
              });
            }
          }
        }
      })
      .catch((error: unknown) => {
        setRemoveError(error instanceof Error ? error.message : "Unable to update workspace.");
      });
  };
  useEffect(
    () =>
      source.subscribeCommands?.((command) => {
        if (inactive || launching) return;
        if (command === "settings") {
          onSettings?.();
        } else if (command === "sidebar") {
          const button = selected ? buttonsRef.current.get(selected) : undefined;
          (button ?? sidebarRef.current)?.focus();
        } else {
          const next = nextWaiting(source.getSnapshot());
          if (next) open(next);
        }
      }),
    [source, inactive, launching, selected, open, onSettings],
  );
  return (
    <main className="board-home" aria-label="Board" hidden={inactive} inert={inactive}>
      {launching && source.worktrees && (
        <WorktreeDialog
          source={source.worktrees}
          initialRepository={launchRepository}
          close={() => {
            setLaunching(false);
          }}
        />
      )}
      {removeError && <p role="alert">{removeError}</p>}
      <div className="board-workspace">
        <Sidebar
          source={source}
          revealRef={revealRef}
          location={location}
          inactive={inactive || launching}
          rows={rows}
          preferences={preferences}
          save={save}
          selected={selected}
          buttons={buttonsRef}
          sidebar={sidebarRef}
          open={open}
          focus={setSelection}
          peek={(id) => {
            setTail([]);
            setPeek(id ? { id } : undefined);
          }}
          choose={(next) => {
            setLocation(next);
            setDisplayed(undefined);
            setPeek(undefined);
            onCloseSettings?.();
          }}
          newWorktree={newWorktree}
          command={command}
          options={options}
          footer={
            <>
              {source.worktrees && (
                <button
                  type="button"
                  onClick={() => {
                    newWorktree();
                  }}
                >
                  New worktree
                </button>
              )}
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
              {onPreflight && (
                <button type="button" onClick={onPreflight}>
                  Preflight
                </button>
              )}
              {onSettings && (
                <button type="button" onClick={onSettings} aria-pressed={settingsOpen}>
                  Settings
                </button>
              )}
            </>
          }
        />
        {settingsView}
        <section
          hidden={settingsOpen}
          inert={settingsOpen}
          className="board-terminal"
          aria-label="Terminal pane"
          tabIndex={-1}
          ref={terminalRef}
        >
          {!openRow && (
            <>
              <div className="terminal-title">
                <h2>
                  {location &&
                    (source.getSidebar?.().find((repo) => repo.path === location.repository)
                      ?.name ??
                      location.repository)}
                  {location?.worktree &&
                    ` › ${
                      source
                        .getSidebar?.()
                        .find((repo) => repo.path === location.repository)
                        ?.worktrees.find((tree) => tree.path === location.worktree)?.branch ??
                      location.worktree
                    }`}
                </h2>
              </div>
              <div className="location-launchers">
                {location &&
                  launcherActions(options, source.shellName?.()).map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      onClick={() => {
                        command({
                          kind: "launch",
                          repository: location.repository,
                          worktree: location.worktree ?? location.repository,
                          run: action.run,
                        });
                      }}
                    >
                      <span className="board-agent" aria-hidden="true">
                        {action.badge}
                      </span>
                      {action.label}
                    </button>
                  ))}
                {source.worktrees && (
                  <button
                    type="button"
                    onClick={() => {
                      newWorktree(location?.repository);
                    }}
                  >
                    New worktree…
                  </button>
                )}
              </div>
            </>
          )}
          <div className="terminal-title" hidden={!openRow}>
            <h2>
              {openRow &&
                `${openRow.repository} › ${openRow.branch} › ${sessionName(openRow, preferences)}`}
            </h2>
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
            <pre>{openRow?.tail.join("\n")}</pre>
            <p>Sample output · read-only</p>
          </div>
          {/* Keep the controller mounted while hidden. The host retains all output. */}
          <div className="shell-slot" hidden={!openRow || openRow.kind === "sample"}>
            {source.shell && (
              <ShellPanel
                source={source.shell}
                canRestart={openRow?.kind === "shell"}
                onRestart={() => {
                  if (openRow?.managed) {
                    command({ kind: "restart", id: openRow.id });
                    return;
                  }
                  void source.shell?.restart().then(() => {
                    const row = source.getSnapshot().find((entry) => entry.kind === "shell");
                    if (row) open(row);
                  });
                }}
              />
            )}
          </div>
          <aside className="board-peek" aria-label="Terminal peek" hidden={!peekRow}>
            <h2>{peekRow && `${peekRow.agent} · ${peekRow.branch}`}</h2>
            <pre>{tail.join("\n")}</pre>
          </aside>
        </section>
      </div>
    </main>
  );
}
