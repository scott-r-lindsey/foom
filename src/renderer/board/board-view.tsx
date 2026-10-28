import { ConfigThemeLauncherContext } from "../preflight/custom-theme-hint";
import type { TerminalFocusRestoration } from "../terminal/terminal-view-source.d";
import { restoreBoardFocus, captureTerminalFocusRestoration } from "./focus-restore";
import type { ComponentProps, ReactNode, SetStateAction } from "react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { applicationErrorCode, errorMessage } from "../../shared/application-errors";
import type { WindowAudioState } from "../../shared/windows";
import type { PreviewSummary, SidebarCommand } from "../../shared/workspace";
import type { SetupSource } from "../preflight/setup-source.d";
import { createSoundController } from "../sound/sound-controller";
import { createAudioSink } from "../sound/web-audio";
import { ActionLog } from "./action-log-view";
import type { BoardSource } from "./board-source.d";
import type { BoardRow } from "./board.d";
import {
  ActionError,
  captureErrorFocus,
  ErrorPresentation,
  useBackgroundErrors,
} from "./error-presentation";
import { SidebarControls } from "./sidebar-controls";
import { repositoryKey, rowRepository, rowWorktree, worktreeKey } from "./sidebar-model";
import { createPreferencesStore, renameSession } from "./sidebar-preferences";
import { Sidebar } from "./sidebar-view";
import { TileArea } from "./tile-area";
import {
  contentId,
  leaves,
  placeContent,
  placeSession,
  sessionId,
  terminals,
  TILE_STORAGE,
} from "./tiles";
import type { TileDrag } from "./tiles.d";
import { useBoardCommands } from "./use-board-commands";
import { useBoardOptions } from "./use-board-options";
import { useBoardTiles } from "./use-board-tiles";

import { useBoardActivity } from "./use-board-activity";
const commandFailures: Readonly<Record<SidebarCommand["kind"], string>> = {
  "open-handoff-link": "Unable to open link.",
  "home-shell": "Unable to start shell.",
  "copy-home-path": "Unable to copy home path.",
  "config-launch": "Unable to launch Foom config.",
  "copy-config-path": "Unable to copy config path.",
  "open-pull-request": "Unable to open pull request.",
  "copy-worktree-path": "Unable to copy worktree path.",
  launch: "Unable to launch session.",
  "remove-worktree": "Unable to remove worktree.",
  "cleanup-worktree": "Unable to clean up worktree.",
  "prune-worktree": "Unable to prune worktree.",
  "delete-merged-worktrees": "Unable to delete merged worktrees.",
  "remove-repository": "Unable to remove repository.",
  stop: "Unable to stop session.",
  close: "Unable to close session.",
  restart: "Unable to restart shell.",
  resume: "Unable to resume conversation.",
  "resume-id": "Unable to resume conversation.",
  "new-conversation": "Unable to start conversation.",
  "copy-session-id": "Unable to copy session ID.",
  "make-orchestrator": "Unable to make orchestrator.",
  "revoke-orchestrator": "Unable to revoke orchestrator.",
  "take-over": "Unable to take over session.",
};
const emptyPreviews: readonly PreviewSummary[] = [];
export function Board(props: ComponentProps<typeof BoardContents>) {
  return (
    <ErrorPresentation>
      <BoardContents {...props} />
    </ErrorPresentation>
  );
}
function BoardContents({
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
  const configPanelRef = useRef<(() => void) | undefined>(undefined);
  const storageKey = source.windows ? `${TILE_STORAGE}.${source.windows.id}` : TILE_STORAGE;
  const [drag, setDrag] = useState<TileDrag>();
  const { report: reportBackground, clear: clearBackground } = useBackgroundErrors();
  const [prune, setPrune] =
    useState<Extract<SidebarCommand, { kind: "remove-worktree" | "prune-worktree" }>>();
  const actionOriginRef = useRef<Element | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const setRemoveError = useCallback((message: SetStateAction<string>) => {
    setPrune(undefined);
    setActionMessage(message);
  }, []);
  const [logOpen, setLogOpen] = useState(false);
  const settingsOpen = Boolean(settingsView) || logOpen;
  const paneInactive = inactive || settingsOpen;
  const rows = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const previews = source.previews?.getSnapshot() ?? emptyPreviews;
  const [arrivals, setArrivals] = useState<ReadonlySet<string>>(() => new Set());
  const acknowledgePreview = (id: string) => {
    setArrivals((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };
  useEffect(() => source.connect?.(), [source]);
  const toggleSidebarRef = useRef<(() => void) | undefined>(undefined);
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const {
    otherViews,
    layout,
    boardRef,
    fontSizeRef,
    fontFamilyRef,
    focusedAtRef,
    layoutRef,
    focusRequest,
    setFocusRequest,
    changeLayout,
    placementOptions,
    tileAction,
  } = useBoardTiles({
    source,
    soundSetup,
    rows,
    previews,
    storageKey,
    setArrivals,
    setRemoveError,
  });
  const [preferencesStore] = useState(() => createPreferencesStore(localStorage, window));
  const preferences = useSyncExternalStore(
    preferencesStore.subscribe,
    preferencesStore.getSnapshot,
  );
  const revealRef = useRef<(row: BoardRow) => void>(undefined);
  const newWorktreeRef = useRef<(repository?: string) => boolean>(undefined);
  const options = useBoardOptions(source, inactive, settingsOpen);
  const save = (next: typeof preferences) => {
    try {
      preferencesStore.save(preferences, next);
      clearBackground("sidebar-preferences");
    } catch {
      reportBackground("sidebar-preferences", "Unable to save sidebar preferences.");
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
  useBoardActivity(source, buttonsRef);
  const [restoreFocusRequest, setRestoreFocusRequest] = useState<TerminalFocusRestoration>();
  const wasInactiveRef = useRef(paneInactive);
  const boardFocusRef = useRef<Element | null>(null);
  const focusedInitialRowRef = useRef(false);
  useLayoutEffect(() => {
    if (!focusedInitialRowRef.current && rows.length) {
      focusedInitialRowRef.current = true;
      buttonsRef.current.values().next().value?.focus();
    }
  }, [rows]);
  useEffect(() => {
    // Child view effects queue attachment first. xterm's container stays hidden
    // until that asynchronous work completes, so queue its input focus as well.
    if (wasInactiveRef.current && !paneInactive) {
      const previous = boardFocusRef.current;
      restoreBoardFocus(previous ?? buttonsRef.current.get(selected ?? "") ?? null);
      if (
        previous?.matches(".xterm-helper-textarea") &&
        previous.closest('.terminal-tile[data-empty="false"]')
      ) {
        // The interim tile fallback must not replace the original xterm if
        // Settings reopens before queued attachment/focus has completed.
        boardFocusRef.current = previous;
        setRestoreFocusRequest(captureTerminalFocusRestoration());
      }
    }
    wasInactiveRef.current = paneInactive;
  }, [paneInactive, selected]);
  const pickPreview = async (worktree: string) => {
    setRemoveError("");
    try {
      const id = await source.previews?.pick(worktree);
      if (!id) return;
      const current = layoutRef.current;
      const next = placeContent(
        current,
        { kind: "preview", preview: id },
        false,
        placementOptions(),
      );
      if (!next) {
        await source.previews?.close(id);
        throw new Error("The tile layout has reached its size limit.");
      }
      changeLayout({ ...next, focused: current.focused, maximized: current.maximized });
    } catch (error) {
      setRemoveError(errorMessage(error, "Unable to open preview."));
    }
  };
  const open = useCallback(
    (
      row: BoardRow,
      replace = false,
      destination?: { tile: string; session: string },
      background = false,
    ) => {
      if (row.dormant && row.exited) return;
      const present = () => {
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
            ...placementOptions(),
            preserveFocus: background,
          },
        );
        if (!next) {
          if (background)
            reportBackground(
              `placement:${row.id}`,
              "The tile layout has reached its size limit.",
              row.id,
            );
          else setRemoveError("The tile layout has reached its size limit.");
          return;
        }
        clearBackground(`placement:${row.id}`);
        changeLayout(
          background ? { ...next, focused: current.focused, maximized: current.maximized } : next,
          background,
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
    [
      source,
      onCloseSettings,
      changeLayout,
      placementOptions,
      layoutRef,
      setFocusRequest,
      reportBackground,
      clearBackground,
      setRemoveError,
    ],
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
  const command = (value: SidebarCommand, space?: string) => {
    actionOriginRef.current = captureErrorFocus();
    setRemoveError("");
    setPrune(undefined);
    const before = new Set(source.getSnapshot().map((row) => row.id));
    const original =
      value.kind === "restart"
        ? leaves(layoutRef.current.tree).find((tile) => sessionId(tile) === value.id)
        : undefined;
    const destination = space
      ? { tile: space, session: "" }
      : original && sessionId(original)
        ? { tile: original.id, session: sessionId(original) ?? "" }
        : undefined;
    return (source.sidebarCommand?.(value) ?? Promise.resolve())
      .then((result) => {
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
          const created = source
            .getSnapshot()
            .find((row) =>
              value.kind === "home-shell"
                ? row.id === result?.terminalId
                : !before.has(row.id) && (value.kind !== "config-launch" || row.config),
            );
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
        setRemoveError(errorMessage(error, commandFailures[value.kind]));
        if (value.kind === "remove-worktree" && applicationErrorCode(error) === "worktree-prunable")
          setPrune(value);
      });
  };
  useBoardCommands({
    source,
    inactive,
    focusedRow,
    setRemoveError,
    selected,
    open,
    onSettings,
    onCloseSettings,
    settingsOpen,
    tileAction,
    changeLayout,
    layoutRef,
    setFocusRequest,
    toggleSidebarRef,
    newWorktreeRef,
    sidebarRef,
    buttonsRef,
    setLogOpen,
    command,
  });
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
    [source, inactive, open, onCloseSettings, layoutRef],
  );
  return (
    <main
      className="board-home"
      onFocusCapture={(event) => {
        if (!paneInactive) boardFocusRef.current = event.target;
      }}
      data-dragging={Boolean(drag)}
      data-preview-covered={paneInactive}
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
      {actionMessage && (
        <ActionError
          returnFocus={() => actionOriginRef.current}
          message={actionMessage}
          close={() => {
            setRemoveError("");
          }}
          fix={
            prune
              ? {
                  label: "Prune",
                  run: () => {
                    void command({ ...prune, kind: "prune-worktree" });
                  },
                }
              : undefined
          }
        />
      )}
      <div className="board-workspace">
        <Sidebar
          configPanelRef={configPanelRef}
          width={layout.sidebarWidth}
          setWidth={(sidebarWidth) => {
            changeLayout({ ...layoutRef.current, sidebarWidth });
          }}
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
            acknowledgePreview(id);
            const tile = leaves(layoutRef.current.tree).find(
              (tile) => tile.content?.kind === "preview" && tile.content.preview === id,
            );
            if (tile) {
              changeLayout({ ...layoutRef.current, focused: tile.id });
              setFocusRequest((value) => value + 1);
            } else {
              const area = boardRef.current?.querySelector(".tile-area");
              const probe = document.createElement("span");
              probe.style.cssText = `position:absolute;visibility:hidden;font:${String(fontSizeRef.current)}px ${fontFamilyRef.current}`;
              probe.textContent = "M";
              boardRef.current?.append(probe);
              const cell = probe.getBoundingClientRect().width || fontSizeRef.current * 0.6;
              probe.remove();
              const next = placeContent(
                layoutRef.current,
                { kind: "preview", preview: id },
                false,
                {
                  columns: (area?.getBoundingClientRect().width ?? 0) / cell,
                  needsYou: new Set(
                    rows.filter((row) => row.state === "needs_input").map((row) => row.id),
                  ),
                  focusedAt: focusedAtRef.current,
                },
              );
              if (next) {
                changeLayout(next);
                setFocusRequest((value) => value + 1);
              } else setRemoveError("The tile layout has reached its size limit.");
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
        {!logOpen && (
          <ConfigThemeLauncherContext
            value={() => {
              configPanelRef.current?.();
            }}
          >
            {settingsView}
          </ConfigThemeLauncherContext>
        )}
        {logOpen && source.actionLog && (
          <ActionLog
            api={source.actionLog}
            subscribe={source.subscribe}
            close={() => {
              setLogOpen(false);
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
            restoreFocusRequest={restoreFocusRequest}
            setLayout={changeLayout}
            rows={rows}
            previews={previews}
            arrivals={arrivals}
            acknowledgePreview={acknowledgePreview}
            preferences={preferences}
            inactive={paneInactive}
            action={(tile, action) => {
              if (action === "popout") {
                const content = leaves(layoutRef.current.tree).find(
                  (item) => item.id === tile,
                )?.content;
                const moving =
                  content?.kind === "preview"
                    ? source.previews?.popout?.(content.preview)
                    : content?.kind === "terminal"
                      ? source.windows?.popout(content.session)
                      : undefined;
                void moving?.catch(() => {
                  setRemoveError("Unable to move tile to a new window.");
                });
              } else if (action === "new-shell") {
                void command({ kind: "home-shell" }, tile);
              } else tileAction(tile, action);
            }}
          />
        </section>
      </div>
    </main>
  );
}
