import type { WindowAudioState } from "../../shared/windows";
import { AgentBadge } from "./agent-badge";
import { ConfirmationButton } from "./confirmation-button";
import { TileArea } from "./tile-area";
import {
  TILE_STORAGE,
  restoreLayout,
  saveLayout,
  loadLayout,
  leaves,
  placeSession,
  preset,
  splitTile,
  closeTile,
  hideSession,
  pruneSessions,
  neighbor,
  swapTiles,
} from "./tiles";
import type { TileDrag, TileLayout, TilePreset } from "./tiles.d";
import type { SetupSource } from "../preflight/setup-source.d";
import { createSoundController } from "../sound/sound-controller";
import { createAudioSink } from "../sound/web-audio";
import { Sidebar, launcherActions } from "./sidebar-view";
import { readPreferences, writePreferences, renameSession } from "./sidebar-preferences";
import type { SidebarLocation } from "./sidebar.d";
import type { SidebarCommand } from "../../shared/workspace";
import type { LaunchOptions } from "./board-source.d";
import {
  sessionIdentity,
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

export function Board({
  source,
  inactive = false,
  onSettings,
  settingsView,
  onCloseSettings,
  soundSetup,
}: {
  source: BoardSource;
  soundSetup?: Pick<SetupSource, "state" | "subscribe">;
  /** Preflight is covering the board; it stays mounted so terminals keep running. */
  inactive?: boolean;
  onSettings?: () => void;
  settingsView?: ReactNode;
  onCloseSettings?: () => void;
}) {
  const storageKey = source.windows ? `${TILE_STORAGE}.${source.windows.id}` : TILE_STORAGE;
  const [otherViews, setOtherViews] = useState<ReadonlySet<string>>(() => new Set());
  const [drag, setDrag] = useState<TileDrag>();
  const [removeError, setRemoveError] = useState("");
  const settingsOpen = Boolean(settingsView);
  const paneInactive = inactive || settingsOpen;
  const rows = useSyncExternalStore(source.subscribe, source.getSnapshot);
  useEffect(() => source.connect?.(), [source]);
  const [layout, setLayout] = useState(() => {
    try {
      return loadLayout(localStorage, storageKey);
    } catch {
      return restoreLayout(null);
    }
  });
  const layoutRef = useRef(layout);
  const [focusRequest, setFocusRequest] = useState(0);
  const changeLayout = useCallback(
    (next: TileLayout) => {
      layoutRef.current = next;
      setLayout(next);
      try {
        saveLayout(localStorage, next, storageKey);
      } catch {
        setRemoveError("Unable to save tile layout.");
      }
    },
    [storageKey],
  );
  useEffect(() => {
    if (source.isReady && !source.isReady()) return;
    const current = layoutRef.current;
    if (
      leaves(current.tree).some(
        (tile) => tile.session && !rows.some((row) => row.id === tile.session),
      )
    ) {
      const next = pruneSessions(current, new Set(rows.map((row) => row.id)));
      layoutRef.current = next;
      setLayout(next);
      try {
        saveLayout(localStorage, next, storageKey);
      } catch {
        setRemoveError("Unable to save tile layout.");
      }
    }
  }, [source, rows, storageKey]);
  useEffect(() => {
    const api = source.windows;
    if (!api) return;
    let active = true;
    const changed = (entries: { id: string; window: number }[]) => {
      if (active)
        setOtherViews(
          new Set(entries.filter((entry) => entry.window !== 0).map((entry) => entry.id)),
        );
    };
    const off = api.onChanged(changed);
    const removed = api.onRemoved((id) => {
      const ids = new Set(
        leaves(layoutRef.current.tree).flatMap((tile) =>
          tile.session && tile.session !== id ? [tile.session] : [],
        ),
      );
      changeLayout(pruneSessions(layoutRef.current, ids));
    });
    void api
      .snapshot()
      .then(changed)
      .catch(() => {});
    return () => {
      active = false;
      off();
      removed();
    };
  }, [source, changeLayout]);
  const reservationRef = useRef<
    { source: BoardSource; layout: TileLayout; ids: string } | undefined
  >(undefined);
  useEffect(() => {
    if (!source.windows || (source.isReady && !source.isReady())) return;
    const current = layout;
    const ids = leaves(current.tree).flatMap((tile) =>
      tile.session && rows.some((row) => row.id === tile.session) ? [tile.session] : [],
    );
    const previous = reservationRef.current;
    const key = JSON.stringify(ids);
    if (previous?.source === source && previous.layout === current && previous.ids === key) return;
    // State/activity updates publish new row objects, not a new set of views.
    // Reconcile only when the layout or its known session IDs actually change.
    const reservation = { source, layout: current, ids: key };
    reservationRef.current = reservation;
    void source.windows
      .sync(ids)
      .then((accepted) => {
        if (layoutRef.current === current && ids.some((id) => !accepted.includes(id)))
          changeLayout(pruneSessions(current, new Set(accepted)));
      })
      .catch(() => {
        if (reservationRef.current === reservation) reservationRef.current = undefined;
        setRemoveError("Unable to reserve terminal views.");
      });
  }, [source, rows, layout, changeLayout]);
  const [refused, setRefused] = useState<string>();
  useEffect(() => {
    if (!refused) return;
    const timer = window.setTimeout(() => {
      setRefused(undefined);
    }, 350);
    return () => {
      window.clearTimeout(timer);
    };
  }, [refused]);
  const tileAction = useCallback(
    (tile: string, action: "right" | "down" | "maximize" | "hide" | "close") => {
      setFocusRequest((value) => value + 1);
      const current = { ...layoutRef.current, focused: tile };
      changeLayout(
        action === "right" || action === "down"
          ? splitTile(current, action === "right" ? "horizontal" : "vertical")
          : action === "close"
            ? closeTile(current)
            : action === "hide"
              ? hideSession(current)
              : { ...current, maximized: current.maximized === tile ? null : tile },
      );
    },
    [changeLayout],
  );
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
  const [selection, setSelection] = useState(rows[0]?.id);
  const selected = rows.some((row) => row.id === selection) ? selection : rows[0]?.id;
  const [peek, setPeek] = useState<{ id: string }>();
  const [tail, setTail] = useState<readonly string[]>([]);
  const buttonsRef = useRef(new Map<string, HTMLElement>());
  const terminalRef = useRef<HTMLElement>(null);
  const focusedSession = leaves(layout.tree).find((tile) => tile.id === layout.focused)?.session;
  const focusedRow = rows.find((row) => row.id === focusedSession);
  const displayedId = focusedRow?.kind === "sample" ? undefined : focusedRow?.id;
  const [audioEnabled, setAudioEnabled] = useState(() => !source.windows?.audio);
  const sharedSoundFocusRef = useRef<string | undefined>(undefined);
  const soundControllerRef = useRef<ReturnType<typeof createSoundController>>(undefined);
  const soundFocusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const audio = source.windows?.audio;
    if (!audio) return;
    let current = true,
      changed = false;
    const update = (state: WindowAudioState) => {
      if (!current) return;
      sharedSoundFocusRef.current = state.focusedId ?? undefined;
      setAudioEnabled(state.enabled);
    };
    const off = audio.onChanged((state) => {
      changed = true;
      update(state);
    });
    const offRefuse = audio.onRefuse(() => {
      soundControllerRef.current?.refuse();
    });
    void audio
      .state()
      .then((state) => {
        if (!changed) update(state);
      })
      .catch(() => {});
    return () => {
      current = false;
      off();
      offRefuse();
    };
  }, [source]);
  useEffect(() => {
    const audio = source.windows?.audio;
    if (!audio) return;
    void audio.focus(paneInactive || location ? null : (displayedId ?? null)).catch(() => {});
  }, [source, paneInactive, location, displayedId]);
  useLayoutEffect(() => {
    soundFocusRef.current = paneInactive || location ? undefined : displayedId;
  }, [paneInactive, location, displayedId]);
  useEffect(() => {
    if (!soundSetup || !audioEnabled) return;
    const controller = createSoundController(source, soundSetup, createAudioSink(), () =>
      source.windows?.audio
        ? sharedSoundFocusRef.current
        : document.hasFocus()
          ? soundFocusRef.current
          : undefined,
    );
    soundControllerRef.current = controller;
    return () => {
      controller();
      soundControllerRef.current = undefined;
    };
  }, [source, soundSetup, audioEnabled]);
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
  }, [source, tailId, peek]);
  const wasInactiveRef = useRef(paneInactive);
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
    (row: BoardRow, replace = false) => {
      const present = () => {
        const next = placeSession(layoutRef.current, row.id, replace);
        if (!next) {
          if (soundControllerRef.current) soundControllerRef.current.refuse();
          else void source.windows?.audio?.refuse().catch(() => {});
          setRefused(row.id);
          return;
        }
        layoutRef.current = next;
        setLayout(next);
        try {
          saveLayout(localStorage, next, storageKey);
        } catch {
          setRemoveError("Unable to save tile layout.");
        }
        setFocusRequest((value) => value + 1);
        setRefused(undefined);
        setSelection(row.id);
        setLocation(undefined);
        revealRef.current?.(row);
        setPeek(undefined);
        setTail([]);
        // Selecting a row asks for terminal input focus, rather than Escape restoration.
        wasInactiveRef.current = false;
        onCloseSettings?.();
        source.markSeen(row.id);
      };
      if (source.windows) {
        void source.windows
          .select(row.id)
          .then((selected) => {
            if (selected) present();
          })
          .catch(() => {
            setRemoveError("Unable to select terminal window.");
          });
      } else present();
    },
    [source, onCloseSettings, storageKey],
  );
  const initialSessionOpenedRef = useRef(false);
  useEffect(() => {
    const id = source.windows?.initialSession;
    const row = rows.find((row) => row.id === id);
    if (!initialSessionOpenedRef.current && row) {
      initialSessionOpenedRef.current = true;
      void Promise.resolve().then(() => {
        open(row, true);
      });
    }
  }, [source, rows, open]);
  const command = (value: SidebarCommand) => {
    setRemoveError("");
    const before = new Set(source.getSnapshot().map((row) => row.id));
    return (source.sidebarCommand?.(value) ?? Promise.resolve())
      .then(() => {
        if (value.kind === "resume" || value.kind === "new-conversation") {
          const resumed = source.getSnapshot().find((row) => row.id === value.id && !row.exited);
          if (resumed) open(resumed, true);
        }
        if (value.kind === "launch" || value.kind === "restart" || value.kind === "home-shell") {
          const created = source.getSnapshot().find((row) => !before.has(row.id));
          if (created) {
            open(
              created,
              value.kind === "restart" ||
                leaves(layoutRef.current.tree).every((tile) => tile.session !== null),
            );
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
        } else if (command === "new-worktree") {
          if (!settingsOpen) {
            setLaunchRepository(undefined);
            setLaunching(true);
          }
        } else if (command === "sidebar") {
          const button = selected ? buttonsRef.current.get(selected) : undefined;
          (button ?? sidebarRef.current)?.focus();
        } else if (command === "next-waiting") {
          const next = nextWaiting(source.getSnapshot());
          if (next) open(next, true);
        } else if (!settingsOpen) {
          const current = layoutRef.current;
          if (
            command === "preset-one" ||
            command === "preset-columns" ||
            command === "preset-rows" ||
            command === "preset-grid" ||
            command === "preset-main2" ||
            command === "preset-main3"
          ) {
            const presets = {
              "preset-one": "one",
              "preset-columns": "columns",
              "preset-rows": "rows",
              "preset-grid": "grid",
              "preset-main2": "main2",
              "preset-main3": "main3",
            } as const;
            changeLayout(preset(current, presets[command]));
          } else if (
            command === "swap-left" ||
            command === "swap-right" ||
            command === "swap-up" ||
            command === "swap-down"
          ) {
            const direction = {
              "swap-left": "left",
              "swap-right": "right",
              "swap-up": "up",
              "swap-down": "down",
            } as const;
            changeLayout(
              swapTiles(current, current.focused, neighbor(current, direction[command])),
            );
            setFocusRequest((value) => value + 1);
          } else if (command.startsWith("tile-")) {
            const tile = leaves(current.tree)[Number(command.slice(5)) - 1];
            if (tile) {
              setFocusRequest((value) => value + 1);
              changeLayout({
                ...current,
                focused: tile.id,
                maximized: current.maximized ? tile.id : null,
              });
            }
          } else if (
            command === "left" ||
            command === "right" ||
            command === "up" ||
            command === "down"
          ) {
            setFocusRequest((value) => value + 1);
            const focused = neighbor(current, command);
            changeLayout({ ...current, focused, maximized: current.maximized ? focused : null });
          } else
            tileAction(
              current.focused,
              command === "split-right"
                ? "right"
                : command === "split-down"
                  ? "down"
                  : command === "hide-session"
                    ? "hide"
                    : command === "close-tile"
                      ? "close"
                      : "maximize",
            );
        }
      }),
    [
      source,
      inactive,
      launching,
      selected,
      open,
      onSettings,
      settingsOpen,
      tileAction,
      changeLayout,
    ],
  );
  useEffect(() => {
    void source.appMenu
      ?.setView({
        available: !inactive && !launching && !settingsOpen,
        maximized: Boolean(layout.maximized),
        tiles: leaves(layout.tree).length,
      })
      .catch((error: unknown) => {
        console.error("Unable to update menu state:", error);
      });
  }, [source, inactive, launching, settingsOpen, layout]);
  useEffect(
    () =>
      source.appMenu?.onSession((id) => {
        if (inactive || launching) return;
        const row = source.getSnapshot().find((row) => row.id === id);
        if (row) {
          onCloseSettings?.();
          const visible = leaves(layoutRef.current.tree).some((tile) => tile.session === row.id);
          open(row, !visible);
        }
      }),
    [source, inactive, launching, open, onCloseSettings],
  );
  return (
    <main
      className="board-home"
      aria-label="Board"
      hidden={inactive}
      inert={inactive}
      onDragStart={(event) => {
        if (
          paneInactive ||
          launching ||
          !(event.target instanceof HTMLElement) ||
          event.target.closest("button, input")
        ) {
          event.preventDefault();
          return;
        }
        const session =
          event.target.closest<HTMLElement>("[data-drag-session]")?.dataset["dragSession"];
        const tile = event.target
          .closest<HTMLElement>(".tile-title")
          ?.closest<HTMLElement>("[data-tile]")?.dataset["tile"];
        if (!session && !tile) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", "Foom tile");
        setPeek(undefined);
        setDrag(session ? { kind: "session", id: session } : { kind: "tile", id: tile ?? "" });
      }}
      onDragEnd={() => {
        setDrag(undefined);
      }}
      onKeyDownCapture={(event) => {
        if (drag && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setDrag(undefined);
        }
      }}
    >
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
          dragging={Boolean(drag)}
          source={source}
          otherViews={otherViews}
          tileNumbers={
            new Map(
              leaves(layout.tree).flatMap((tile, index) =>
                tile.session
                  ? [[tile.session, { number: index + 1, focused: tile.id === layout.focused }]]
                  : [],
              ),
            )
          }
          refused={refused}
          clearRefusal={() => {
            setRefused(undefined);
          }}
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
            setPeek(undefined);
            onCloseSettings?.();
          }}
          newWorktree={newWorktree}
          command={command}
          options={options}
          footer={
            <>
              <div className="tile-presets" role="group" aria-label="Tile layout">
                {(
                  [
                    ["one", "One", "M1 1h14v10H1z"],
                    ["columns", "Two side by side", "M1 1h14v10H1z M8 1v10"],
                    ["rows", "Two stacked", "M1 1h14v10H1z M1 6h14"],
                    ["grid", "Two by two", "M1 1h14v10H1z M8 1v10 M1 6h14"],
                    ["main2", "One and two", "M1 1h14v10H1z M9 1v10 M9 6h6"],
                    ["main3", "One and three", "M1 1h14v10H1z M9 1v10 M9 4h6 M9 8h6"],
                  ] satisfies [TilePreset, string, string][]
                ).map(([key, label, path]) => (
                  <button
                    key={key}
                    type="button"
                    aria-label={label}
                    title={label}
                    onClick={() => {
                      changeLayout(preset(layoutRef.current, key));
                    }}
                  >
                    <svg width="18" height="14" viewBox="0 0 16 12" aria-hidden="true">
                      <path d={path} fill="none" stroke="currentColor" />
                    </svg>
                  </button>
                ))}
              </div>
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
          {location && (
            <>
              <div className="terminal-title">
                <h2>
                  {source.getSidebar?.().find((repo) => repo.path === location.repository)?.name ??
                    location.repository}
                  {location.worktree &&
                    ` › ${
                      location.worktree === location.repository
                        ? "Main checkout"
                        : (source
                            .getSidebar?.()
                            .find((repo) => repo.path === location.repository)
                            ?.worktrees.find((tree) => tree.path === location.worktree)?.branch ??
                          location.worktree)
                    }`}
                </h2>
              </div>
              <div className="location-launchers">
                {location.worktree &&
                source.getSidebar &&
                !source
                  .getSidebar()
                  .some(
                    (repo) =>
                      repo.path === location.repository &&
                      repo.worktrees.some(
                        (tree) => tree.path === location.worktree && !tree.prunable,
                      ),
                  ) ? (
                  <span className="worktree-removed">
                    <span aria-hidden="true">⊘</span> Worktree removed
                  </span>
                ) : (
                  launcherActions(options, source.shellName?.()).map((action) => (
                    <ConfirmationButton
                      client={source.confirmations}
                      key={action.label}
                      action={() => {
                        return command({
                          kind: "launch",
                          repository: location.repository,
                          worktree: location.worktree ?? location.repository,
                          run: action.run,
                        });
                      }}
                    >
                      <AgentBadge mark={action.badge} />
                      {action.label}
                    </ConfirmationButton>
                  ))
                )}
                {source.worktrees && (
                  <button
                    type="button"
                    onClick={() => {
                      newWorktree(location.repository);
                    }}
                  >
                    New worktree…
                  </button>
                )}
              </div>
            </>
          )}
          <TileArea
            dropLayout={(next) => {
              changeLayout(next);
              setFocusRequest((value) => value + 1);
            }}
            drag={drag}
            endDrag={() => {
              setDrag(undefined);
            }}
            source={source}
            layout={layout}
            focusRequest={focusRequest}
            setLayout={changeLayout}
            rows={rows}
            preferences={preferences}
            inactive={paneInactive || Boolean(location)}
            action={(tile, action) => {
              if (action === "popout") {
                const session = leaves(layoutRef.current.tree).find(
                  (item) => item.id === tile,
                )?.session;
                if (session)
                  void source.windows?.popout(session).catch(() => {
                    setRemoveError("Unable to move session to a new window.");
                  });
              } else if (action === "restart") {
                const session = leaves(layoutRef.current.tree).find(
                  (item) => item.id === tile,
                )?.session;
                if (session) void command({ kind: "restart", id: session });
              } else tileAction(tile, action);
            }}
          />
          <aside className="board-peek" aria-label="Terminal peek" hidden={!peekRow}>
            <h2>
              {peekRow && `${sessionIdentity(peekRow, source.shellName?.())} · ${peekRow.branch}`}
            </h2>
            <pre>{tail.join("\n")}</pre>
          </aside>
        </section>
      </div>
    </main>
  );
}
