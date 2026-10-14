import { terminalFontStack, TERMINAL_FONT_FALLBACK } from "../../shared/terminal-fonts";
import type { PreviewSummary } from "../../shared/workspace";
import type { WindowAudioState } from "../../shared/windows";
import { ActionLog } from "./action-log-view";
import { TileArea } from "./tile-area";
import {
  TILE_STORAGE,
  restoreLayout,
  saveLayout,
  loadLayout,
  leaves,
  placeSession,
  placeContent,
  tidyTiles,
  splitTile,
  closeTile,
  hideSession,
  growTile,
  terminals,
  pruneContent,
  sessionId,
  contentId,
  neighbor,
  swapTiles,
} from "./tiles";
import type { TileDrag, TileLayout } from "./tiles.d";
import type { SetupSource } from "../preflight/setup-source.d";
import { createSoundController } from "../sound/sound-controller";
import { createAudioSink } from "../sound/web-audio";
import { SidebarControls } from "./sidebar-controls";
import { Sidebar } from "./sidebar-view";
import { readPreferences, writePreferences, renameSession } from "./sidebar-preferences";
import type { SidebarCommand } from "../../shared/workspace";
import type { LaunchOptions } from "./board-source.d";
import { repositoryKey, worktreeKey, rowRepository, rowWorktree } from "./sidebar-model";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import type { BoardSource } from "./board-source.d";
import type { BoardRow } from "./board.d";
import { subscribeLights } from "./light-activity";
import { nextWaiting, waitTime } from "./board";

const emptyPreviews: readonly PreviewSummary[] = [];
export function Board({
  source,
  inactive = false,
  onSettings,
  settingsView,
  onCloseSettings,
  soundSetup,
}: {
  source: BoardSource;
  soundSetup?: Pick<SetupSource, "state" | "subscribe"> & Partial<Pick<SetupSource, "save">>;
  /** Preflight is covering the board; it stays mounted so terminals keep running. */
  inactive?: boolean;
  onSettings?: (section?: "config") => void;
  settingsView?: ReactNode;
  onCloseSettings?: () => void;
}) {
  const storageKey = source.windows ? `${TILE_STORAGE}.${source.windows.id}` : TILE_STORAGE;
  const [otherViews, setOtherViews] = useState<ReadonlySet<string>>(() => new Set());
  const [drag, setDrag] = useState<TileDrag>();
  const [removeError, setRemoveError] = useState("");
  const [logOpen, setLogOpen] = useState(false);
  const settingsOpen = Boolean(settingsView) || logOpen;
  const paneInactive = inactive || settingsOpen;
  const rows = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const previews = source.previews?.getSnapshot() ?? emptyPreviews;
  useEffect(() => source.connect?.(), [source]);
  const [layout, setLayout] = useState(() => {
    try {
      return loadLayout(localStorage, storageKey);
    } catch {
      return restoreLayout(null);
    }
  });
  const toggleSidebarRef = useRef<(() => void) | undefined>(undefined);
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const fontSizeRef = useRef(14);
  const fontFamilyRef = useRef(TERMINAL_FONT_FALLBACK);
  const focusedAtRef = useRef(new Map<string, number>());
  const focusClockRef = useRef(0);
  useEffect(() => {
    if (!soundSetup) return;
    let active = true;
    let changed = false;
    const off = soundSetup.subscribe((state) => {
      changed = true;
      fontSizeRef.current = state.settings.terminalFontSize;
      fontFamilyRef.current = terminalFontStack(state.settings.terminalFont);
    });
    void soundSetup
      .state()
      .then((state) => {
        if (active && !changed) {
          fontSizeRef.current = state.settings.terminalFontSize;
          fontFamilyRef.current = terminalFontStack(state.settings.terminalFont);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
      off();
    };
  }, [soundSetup]);
  const layoutRef = useRef(layout);
  const [focusRequest, setFocusRequest] = useState(0);
  const changeLayout = useCallback(
    (next: TileLayout) => {
      next = {
        ...next,
        sidebarCollapsed: next.sidebarCollapsed ?? layoutRef.current.sidebarCollapsed ?? false,
      };
      if (
        next.focused !== layoutRef.current.focused ||
        leaves(next.tree).find((tile) => tile.id === next.focused)?.content !==
          leaves(layoutRef.current.tree).find((tile) => tile.id === next.focused)?.content
      ) {
        focusedAtRef.current.set(next.focused, ++focusClockRef.current);
      }
      const retained = new Set(
        leaves(next.tree).flatMap((tile) =>
          tile.content?.kind === "preview" ? [tile.content.preview] : [],
        ),
      );
      for (const tile of leaves(layoutRef.current.tree)) {
        if (tile.content?.kind === "preview" && !retained.has(tile.content.preview)) {
          void source.previews?.close(tile.content.preview).catch(() => {
            setRemoveError("Unable to close preview.");
          });
        }
      }
      layoutRef.current = next;
      setLayout(next);
      try {
        saveLayout(localStorage, next, storageKey);
      } catch {
        setRemoveError("Unable to save tile layout.");
      }
    },
    [storageKey, source],
  );
  useEffect(() => {
    if (source.isReady && !source.isReady()) return;
    const current = layoutRef.current;
    if (
      leaves(current.tree).some((tile) =>
        tile.content?.kind === "preview"
          ? !previews.some((preview) => preview.id === contentId(tile.content))
          : sessionId(tile) && !rows.some((row) => row.id === sessionId(tile)),
      )
    ) {
      const next = pruneContent(current, {
        sessions: new Set(rows.map((row) => row.id)),
        previews: new Set(previews.map((preview) => preview.id)),
      });
      layoutRef.current = next;
      setLayout(next);
      try {
        saveLayout(localStorage, next, storageKey);
      } catch {
        setRemoveError("Unable to save tile layout.");
      }
    }
  }, [source, rows, previews, storageKey]);
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
          sessionId(tile) && sessionId(tile) !== id ? [sessionId(tile) ?? ""] : [],
        ),
      );
      changeLayout(
        pruneContent(layoutRef.current, {
          sessions: ids,
          previews: new Set(previews.map((preview) => preview.id)),
        }),
      );
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
  }, [source, changeLayout, previews]);
  const reservationRef = useRef<
    { source: BoardSource; layout: TileLayout; ids: string } | undefined
  >(undefined);
  useEffect(() => {
    if (!source.windows || (source.isReady && !source.isReady())) return;
    const current = layout;
    const ids = leaves(current.tree).flatMap((tile) =>
      sessionId(tile) && rows.some((row) => row.id === sessionId(tile))
        ? [sessionId(tile) ?? ""]
        : [],
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
          changeLayout(
            pruneContent(current, {
              sessions: new Set(accepted),
              previews: new Set(previews.map((preview) => preview.id)),
            }),
          );
      })
      .catch(() => {
        if (reservationRef.current === reservation) reservationRef.current = undefined;
        setRemoveError("Unable to reserve terminal views.");
      });
  }, [source, rows, previews, layout, changeLayout]);
  const tileAction = useCallback(
    (
      tile: string,
      action: "right" | "down" | "growx" | "growy" | "maximize" | "hide" | "close",
    ) => {
      setFocusRequest((value) => value + 1);
      const current = { ...layoutRef.current, focused: tile };
      const session = sessionId(leaves(current.tree).find((item) => item.id === tile));
      const content = leaves(current.tree).find((item) => item.id === tile)?.content;
      if (action === "maximize" && !content) return;
      if (
        action === "close" &&
        session &&
        source.getSnapshot().some((row) => row.id === session && row.exited)
      ) {
        void source
          .sidebarCommand?.({ kind: "close", id: session })
          .then(() => {
            if (
              leaves(layoutRef.current.tree).some(
                (item) =>
                  item.id === tile && (sessionId(item) === session || item.content === null),
              )
            ) {
              changeLayout(closeTile({ ...layoutRef.current, focused: tile }));
              setFocusRequest((value) => value + 1);
            }
          })
          .catch(() => {
            setRemoveError("Unable to close session.");
          });
        return;
      }
      changeLayout(
        action === "growx" || action === "growy"
          ? growTile(current, action === "growx" ? "horizontal" : "vertical")
          : action === "right" || action === "down"
            ? splitTile(current, action === "right" ? "horizontal" : "vertical")
            : action === "close"
              ? closeTile(current)
              : action === "hide"
                ? hideSession(current)
                : { ...current, maximized: current.maximized === tile ? null : tile },
      );
    },
    [changeLayout, source],
  );
  const [preferences, setPreferences] = useState(() => readPreferences(localStorage));
  const revealRef = useRef<(row: BoardRow) => void>(undefined);
  const newWorktreeRef = useRef<(repository?: string) => boolean>(undefined);
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
  const [selection, setSelection] = useState(rows[0]?.id);
  const selected = rows.some((row) => row.id === selection) ? selection : rows[0]?.id;
  const buttonsRef = useRef(new Map<string, HTMLElement>());
  const terminalRef = useRef<HTMLElement>(null);
  const focusedSession = sessionId(leaves(layout.tree).find((tile) => tile.id === layout.focused));
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
    void audio.focus(paneInactive ? null : (displayedId ?? null)).catch(() => {});
  }, [source, paneInactive, displayedId]);
  useLayoutEffect(() => {
    soundFocusRef.current = paneInactive ? undefined : displayedId;
  }, [paneInactive, displayedId]);
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
      subscribeLights(source, () =>
        source.getSnapshot().flatMap((row) => {
          const button = buttonsRef.current.get(row.id);
          const element = button?.querySelector<HTMLElement>(".board-light");
          return element
            ? [
                {
                  row,
                  element,
                  trace: button?.querySelector<SVGPathElement>(".activity-trace path"),
                },
              ]
            : [];
        }),
      ),
    [source],
  );
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
  const pickPreview = async (worktree: string) => {
    setRemoveError("");
    try {
      const id = await source.previews?.pick(worktree);
      if (!id) return;
      const area = boardRef.current?.querySelector(".tile-area");
      const probe = document.createElement("span");
      probe.style.cssText = `position:absolute;visibility:hidden;font:${String(fontSizeRef.current)}px ${fontFamilyRef.current}`;
      probe.textContent = "M";
      boardRef.current?.append(probe);
      const cell = probe.getBoundingClientRect().width || fontSizeRef.current * 0.6;
      probe.remove();
      const current = layoutRef.current;
      const next = placeContent(current, { kind: "preview", preview: id }, false, {
        columns: (area?.getBoundingClientRect().width ?? 0) / cell,
        needsYou: new Set(
          source
            .getSnapshot()
            .filter((row) => row.state === "needs_input")
            .map((row) => row.id),
        ),
        focusedAt: focusedAtRef.current,
      });
      if (!next) {
        await source.previews?.close(id);
        throw new Error("The tile layout has reached its size limit.");
      }
      changeLayout({ ...next, focused: current.focused, maximized: current.maximized });
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : "Unable to open preview.");
    }
  };
  const open = useCallback(
    (
      row: BoardRow,
      replace = false,
      destination?: { tile: string; session: string },
      background = false,
    ) => {
      const present = () => {
        const area = boardRef.current?.querySelector(".tile-area");
        const probe = document.createElement("span");
        probe.style.cssText = `position:absolute;visibility:hidden;font:${String(fontSizeRef.current)}px ${fontFamilyRef.current}`;
        probe.textContent = "M";
        boardRef.current?.append(probe);
        const cell = probe.getBoundingClientRect().width || fontSizeRef.current * 0.6;
        probe.remove();
        const current = layoutRef.current;
        const own =
          destination &&
          leaves(current.tree).find(
            (tile) =>
              tile.id === destination.tile &&
              (tile.content === null || sessionId(tile) === destination.session),
          );
        const next = placeSession(
          own ? { ...current, focused: own.id } : current,
          row.id,
          replace || Boolean(own),
          {
            columns: (area?.getBoundingClientRect().width ?? 0) / cell,
            needsYou: new Set(
              source
                .getSnapshot()
                .filter((item) => item.state === "needs_input")
                .map((item) => item.id),
            ),
            focusedAt: focusedAtRef.current,
            preserveFocus: background,
          },
        );
        if (!next) {
          setRemoveError("The tile layout has reached its size limit.");
          return;
        }
        changeLayout(
          background ? { ...next, focused: current.focused, maximized: current.maximized } : next,
        );
        if (background) return;
        setFocusRequest((value) => value + 1);
        setSelection(row.id);
        revealRef.current?.(row);
        // Selecting a row asks for terminal input focus, rather than Escape restoration.
        wasInactiveRef.current = false;
        onCloseSettings?.();
        source.markSeen(row.id);
      };
      if (source.windows && !background) {
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
    [source, onCloseSettings, changeLayout],
  );
  const initialSessionOpenedRef = useRef(false);
  useEffect(() => {
    const id = source.windows?.initialSession;
    const row = rows.find((row) => row.id === id);
    if (!initialSessionOpenedRef.current && row) {
      initialSessionOpenedRef.current = true;
      void Promise.resolve().then(() => {
        open(row);
      });
    }
  }, [source, rows, open]);
  const command = (value: SidebarCommand) => {
    setRemoveError("");
    const before = new Set(source.getSnapshot().map((row) => row.id));
    const original =
      value.kind === "restart"
        ? leaves(layoutRef.current.tree).find((tile) => sessionId(tile) === value.id)
        : undefined;
    const destination =
      original && sessionId(original)
        ? { tile: original.id, session: sessionId(original) ?? "" }
        : undefined;
    return (source.sidebarCommand?.(value) ?? Promise.resolve())
      .then(() => {
        if (value.kind === "resume" || value.kind === "new-conversation") {
          const resumed = source.getSnapshot().find((row) => row.id === value.id && !row.exited);
          if (resumed) open(resumed, true);
        }
        if (
          value.kind === "launch" ||
          value.kind === "resume-id" ||
          value.kind === "restart" ||
          value.kind === "home-shell" ||
          value.kind === "config-launch"
        ) {
          // One config session at a time: a second launch focuses the running one.
          const created =
            value.kind === "config-launch"
              ? source.getSnapshot().find((row) => row.config && !row.exited)
              : source.getSnapshot().find((row) => !before.has(row.id));
          if (created) {
            open(created, false, destination);
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
        if (value.kind === "resume-id") throw error;
        setRemoveError(error instanceof Error ? error.message : "Unable to update workspace.");
      });
  };
  const runSidebarCommand = useEffectEvent(command);
  useEffect(
    () =>
      source.subscribeCommands?.((command) => {
        if (inactive) return;
        if (command === "via-claude" || command === "via-codex" || command === "via-agy") {
          const agent = { "via-claude": "claude", "via-codex": "codex", "via-agy": "agy" } as const;
          void runSidebarCommand({ kind: "config-launch", run: agent[command], origin: "menu" });
        } else if (command === "toggle-sidebar") {
          toggleSidebarRef.current?.();
        } else if (command === "action-log") {
          if (source.actionLog) {
            onCloseSettings?.();
            setLogOpen(true);
          }
        } else if (command === "settings") {
          setLogOpen(false);
          onSettings?.();
        } else if (
          command === "add-repository" ||
          (command === "new-worktree" &&
            !settingsOpen &&
            // The focused tile's repository, else the sidebar's top one; else add one.
            !newWorktreeRef.current?.(
              focusedRow && !focusedRow.home && !focusedRow.config
                ? rowRepository(focusedRow)
                : undefined,
            ))
        ) {
          void source.worktrees?.addRepository().catch(() => {
            setRemoveError("Unable to add repository.");
          });
        } else if (command === "sidebar") {
          const button = selected ? buttonsRef.current.get(selected) : undefined;
          (button ?? sidebarRef.current)?.focus();
        } else if (command === "next-waiting") {
          const next = nextWaiting(source.getSnapshot());
          if (next) open(next, true);
        } else if (!settingsOpen) {
          const current = layoutRef.current;
          if (command === "tidy-tiles") {
            changeLayout(tidyTiles(current));
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
            const tile = terminals(current.tree)[Number(command.slice(5)) - 1];
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
      focusedRow,
      selected,
      open,
      onSettings,
      onCloseSettings,
      settingsOpen,
      tileAction,
      changeLayout,
    ],
  );
  useEffect(() => {
    void source.appMenu
      ?.setView({
        available: !inactive && !settingsOpen,
        configAvailable: !inactive,
        maximized: Boolean(layout.maximized),
        sidebarCollapsed: sidebarCompact,
        tiles: terminals(layout.tree).length,
      })
      .catch((error: unknown) => {
        console.error("Unable to update menu state:", error);
      });
  }, [source, inactive, settingsOpen, layout, sidebarCompact]);
  const arrivalsRef = useRef(new Set<string>());
  const placeArrivals = useEffectEvent(() => {
    for (const id of arrivalsRef.current) {
      const row = source.getSnapshot().find((row) => row.id === id);
      if (!row) continue;
      arrivalsRef.current.delete(id);
      open(row, false, undefined, true);
    }
  });
  useEffect(
    () =>
      source.subscribe(() => {
        placeArrivals();
      }),
    [source],
  );
  useEffect(
    () =>
      source.appMenu?.onSession((id, background) => {
        if (background) {
          arrivalsRef.current.add(id);
          placeArrivals();
          return;
        }
        if (inactive) return;
        const row = source.getSnapshot().find((row) => row.id === id);
        if (row) {
          onCloseSettings?.();
          const visible = leaves(layoutRef.current.tree).some((tile) => sessionId(tile) === row.id);
          open(row, !visible);
        }
      }),
    [source, inactive, open, onCloseSettings],
  );
  return (
    <main
      className="board-home"
      ref={boardRef}
      aria-label="Board"
      hidden={inactive}
      inert={inactive}
      onDragStart={(event) => {
        if (
          paneInactive ||
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
      {removeError && <p role="alert">{removeError}</p>}
      <div className="board-workspace">
        <Sidebar
          collapsed={layout.sidebarCollapsed ?? false}
          setCollapsed={(sidebarCollapsed) => {
            changeLayout({ ...layoutRef.current, sidebarCollapsed });
          }}
          toggleRef={toggleSidebarRef}
          onCompact={setSidebarCompact}
          dragging={Boolean(drag)}
          source={source}
          otherViews={otherViews}
          tileNumbers={
            new Map(
              terminals(layout.tree).flatMap((tile, index) =>
                contentId(tile.content)
                  ? [
                      [
                        contentId(tile.content) ?? "",
                        { number: index + 1, focused: tile.id === layout.focused },
                      ],
                    ]
                  : [],
              ),
            )
          }
          previews={previews}
          pickPreview={pickPreview}
          openPreview={(id) => {
            const tile = leaves(layoutRef.current.tree).find(
              (tile) => tile.content?.kind === "preview" && tile.content.preview === id,
            );
            if (tile) {
              changeLayout({ ...layoutRef.current, focused: tile.id });
              setFocusRequest((value) => value + 1);
            }
          }}
          revealRef={revealRef}
          {...(onSettings ? { openSettings: onSettings } : {})}
          inactive={inactive}
          rows={rows}
          preferences={preferences}
          save={save}
          selected={selected}
          buttons={buttonsRef}
          sidebar={sidebarRef}
          open={open}
          focus={setSelection}
          newWorktreeRef={newWorktreeRef}
          command={command}
          options={options}
          footer={<SidebarControls source={soundSetup} />}
        />
        {!logOpen && settingsView}
        {logOpen && source.actionLog && (
          <ActionLog
            api={source.actionLog}
            subscribe={source.subscribe}
            close={() => {
              setLogOpen(false);
              setFocusRequest((value) => value + 1);
            }}
          />
        )}
        <section
          hidden={settingsOpen}
          inert={settingsOpen}
          className="board-terminal"
          aria-label="Terminal pane"
          tabIndex={-1}
          ref={terminalRef}
        >
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
            previews={previews}
            preferences={preferences}
            inactive={paneInactive}
            action={(tile, action) => {
              if (action === "popout") {
                const session = sessionId(
                  leaves(layoutRef.current.tree).find((item) => item.id === tile),
                );
                if (session)
                  void source.windows?.popout(session).catch(() => {
                    setRemoveError("Unable to move session to a new window.");
                  });
              } else tileAction(tile, action);
            }}
          />
        </section>
      </div>
    </main>
  );
}
