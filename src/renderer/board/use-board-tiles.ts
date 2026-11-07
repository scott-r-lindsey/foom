import { readPreferences } from "./sidebar-preferences";
import { errorMessage } from "../../shared/application-errors";
import { prepareMove, finishMove } from "./move-placement";
import { useBackgroundErrors } from "./error-presentation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TERMINAL_FONT_FALLBACK, terminalFontStack } from "../../shared/terminal-fonts";
import type { PreviewSummary } from "../../shared/workspace";
import type { SetupSource } from "../preflight/setup-source.d";
import type { BoardSource } from "./board-source.d";
import type { BoardRow } from "./board.d";
import {
  fitLayout,
  MIN_TILE_COLUMNS,
  splitReason,
  closeTile,
  closeSpace,
  growTile,
  hideSession,
  leaves,
  loadLayout,
  placeAgentPreview,
  placeSession,
  pruneContent,
  restoreLayout,
  saveLayout,
  sessionId,
  splitTile,
} from "./tiles";
import type { TileAction, TileLayout, TileStartupReservation } from "./tiles.d";

import type { Dispatch, SetStateAction } from "react";
export function useBoardTiles({
  source,
  soundSetup,
  rows,
  previews,
  storageKey,
  setArrivals,
  setRemoveError,
}: {
  source: BoardSource;
  soundSetup:
    | (Pick<SetupSource, "state" | "subscribe"> & Partial<Pick<SetupSource, "save">>)
    | undefined;
  rows: readonly BoardRow[];
  previews: readonly PreviewSummary[];
  storageKey: string;
  setArrivals: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setRemoveError: Dispatch<SetStateAction<string>>;
}) {
  const { report, clear } = useBackgroundErrors();
  const [otherViews, setOtherViews] = useState<ReadonlySet<string>>(() => new Set());
  const [layout, setLayout] = useState(() => {
    try {
      return loadLayout(
        localStorage,
        storageKey,
        readPreferences(localStorage).expanded,
        source.windows?.restored,
      );
    } catch {
      return restoreLayout(null);
    }
  });
  const boardRef = useRef<HTMLDivElement>(null);
  const fontSizeRef = useRef(14);
  const fontFamilyRef = useRef(TERMINAL_FONT_FALLBACK);
  const fontSettingsSourceRef = useRef<typeof soundSetup>(undefined);
  const focusedAtRef = useRef(new Map<string, number>());
  const focusClockRef = useRef(0);
  const repairTilesRef = useRef<(() => void) | undefined>(undefined);
  const unrestoredRolesRef = useRef(new Set<string>());
  useEffect(() => {
    if (!soundSetup) return;
    let active = true;
    let changed = false;
    const off = soundSetup.subscribe((state) => {
      if (!active) return;
      changed = true;
      fontSizeRef.current = state.settings.terminalFontSize;
      fontFamilyRef.current = terminalFontStack(state.settings.terminalFont);
      fontSettingsSourceRef.current = soundSetup;
      repairTilesRef.current?.();
    });
    void soundSetup
      .state()
      .then((state) => {
        if (active && !changed) {
          fontSizeRef.current = state.settings.terminalFontSize;
          fontFamilyRef.current = terminalFontStack(state.settings.terminalFont);
          fontSettingsSourceRef.current = soundSetup;
          repairTilesRef.current?.();
        }
      })
      .catch(() => {});
    return () => {
      active = false;
      if (fontSettingsSourceRef.current === soundSetup) fontSettingsSourceRef.current = undefined;
      off();
    };
  }, [soundSetup]);
  const layoutRef = useRef(layout);
  const startupLayoutsRef = useRef(new Map<string, TileStartupReservation>());
  const startupIdsRef = useRef<ReadonlySet<string>>(new Set());
  useLayoutEffect(() => {
    startupIdsRef.current = new Set(rows.filter((row) => row.startup).map((row) => row.id));
  }, [rows]);
  const movePendingRef = useRef<{ request: string; next: TileLayout } | undefined>(undefined);
  const previewIds = useCallback(
    (current: TileLayout) =>
      new Set(
        source.previews?.isReady?.() === false
          ? leaves(current.tree).flatMap((tile) =>
              tile.content?.kind === "preview" ? [tile.content.preview] : [],
            )
          : (source.previews?.getSnapshot() ?? []).map((preview) => preview.id),
      ),
    [source],
  );
  const measureTiles = useCallback(() => {
    const area = boardRef.current?.querySelector(".tile-area")?.getBoundingClientRect();
    const probe = document.createElement("span");
    probe.style.cssText = `position:absolute;visibility:hidden;font:${String(fontSizeRef.current)}px ${fontFamilyRef.current}`;
    probe.textContent = "M";
    boardRef.current?.append(probe);
    const cell = probe.getBoundingClientRect().width || fontSizeRef.current * 0.6;
    probe.remove();
    return {
      columns: (area?.width ?? 0) / cell,
      // Do not destroy saved spaces using fallback font metrics before settings arrive.
      metrics:
        fontSettingsSourceRef.current === soundSetup
          ? {
              width: area?.width ?? 0,
              height: area?.height ?? 0,
              minWidth: MIN_TILE_COLUMNS * cell,
              minHeight: 38 + 3 * fontSizeRef.current * 1.2,
            }
          : undefined,
    };
  }, [soundSetup]);
  const [splitRefusal, setSplitRefusal] = useState("");
  const [focusRequest, setFocusRequest] = useState(0);
  const changeLayout = useCallback(
    (next: TileLayout, background = false, transient = false) => {
      if (movePendingRef.current) return;
      setSplitRefusal("");
      next = fitLayout(next, measureTiles().metrics, !transient);
      next = {
        ...next,
        sidebarExpanded: next.sidebarExpanded ?? layoutRef.current.sidebarExpanded ?? {},
        sidebarCollapsed: next.sidebarCollapsed ?? layoutRef.current.sidebarCollapsed ?? false,
        sidebarWidth: next.sidebarWidth ?? layoutRef.current.sidebarWidth,
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
      setArrivals((current) => {
        const nextArrivals = new Set([...current].filter((id) => retained.has(id)));
        return nextArrivals.size === current.size ? current : nextArrivals;
      });
      for (const tile of leaves(layoutRef.current.tree)) {
        if (tile.content?.kind === "preview" && !retained.has(tile.content.preview)) {
          const id = tile.content.preview;
          void source.previews
            ?.close(id)
            .then(() => {
              clear(`preview-close:${id}`);
            })
            .catch(() => {
              if (background) report(`preview-close:${id}`, "Unable to close preview.", id);
              else setRemoveError("Unable to close preview.");
            });
        }
      }
      const ids = new Set(leaves(next.tree).map(sessionId));
      for (const id of startupLayoutsRef.current.keys())
        if (!ids.has(id)) startupLayoutsRef.current.delete(id);
      for (const id of ids)
        if (id?.startsWith("launch_") && !startupLayoutsRef.current.has(id))
          startupLayoutsRef.current.set(id, {
            id,
            before: layoutRef.current.tree,
            placed: next.tree,
            pending: true,
          });
      layoutRef.current = next;
      setLayout(next);
      if (transient) return;
      try {
        saveLayout(localStorage, next, storageKey, [...startupLayoutsRef.current.values()]);
        clear("tile-layout");
      } catch {
        report("tile-layout", "Unable to save tile layout.");
      }
    },
    [storageKey, source, clear, report, measureTiles],
  );
  const failStartup = useCallback(
    (id: string) => {
      const reservation = startupLayoutsRef.current.get(id);
      if (reservation) reservation.pending = false;
      changeLayout(layoutRef.current, true);
    },
    [changeLayout],
  );
  // A transfer reserves geometry, but a startup may gain its terminal ID meanwhile.
  const completeStartup = useCallback(
    (before: string, after: string) => {
      const bind = (current: TileLayout): TileLayout => {
        const tile = leaves(current.tree).find((leaf) => sessionId(leaf) === before);
        if (!tile) return current;
        const next = placeSession({ ...current, focused: tile.id }, after, true);
        return next ? { ...next, focused: current.focused, maximized: current.maximized } : current;
      };
      const pending = movePendingRef.current;
      if (pending) {
        pending.next = bind(pending.next);
        layoutRef.current = bind(layoutRef.current);
        setLayout(layoutRef.current);
      } else changeLayout(bind(layoutRef.current));
    },
    [changeLayout],
  );
  const placementOptions = useCallback(() => {
    return {
      ...measureTiles(),
      needsYou: new Set(
        source
          .getSnapshot()
          .filter((row) => row.state === "needs_input")
          .map((row) => row.id),
      ),
      focusedAt: focusedAtRef.current,
    };
  }, [source, measureTiles]);
  useEffect(() => {
    const area = boardRef.current?.querySelector(".tile-area");
    if (!area) return;
    const repair = () => {
      const next = fitLayout(layoutRef.current, measureTiles().metrics);
      if (next !== layoutRef.current) changeLayout(next, true);
    };
    repairTilesRef.current = repair;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(repair);
    observer?.observe(area);
    repair();
    return () => {
      observer?.disconnect();
      repairTilesRef.current = undefined;
    };
  }, [changeLayout, measureTiles]);
  useEffect(() => {
    const api = source.windows?.moves;
    if (!api) return;
    const prepare = api.onPrepare((request, at) => {
      const covered = boardRef.current?.dataset["previewCovered"] === "true";
      const next =
        movePendingRef.current || covered
          ? null
          : prepareMove(layoutRef.current, at, placementOptions());
      if (next) {
        movePendingRef.current = { request, next };
        boardRef.current?.setAttribute("inert", "");
      }
      void api.ready(request, Boolean(next)).catch(() => {
        if (movePendingRef.current?.request === request) {
          movePendingRef.current = undefined;
          boardRef.current?.removeAttribute("inert");
        }
      });
    });
    const finish = api.onFinish((request, content) => {
      const pending = movePendingRef.current;
      if (pending?.request !== request) return;
      movePendingRef.current = undefined;
      boardRef.current?.removeAttribute("inert");
      if (content) {
        const next = finishMove(pending.next, content);
        const sessions = new Set(
          source.isReady?.() === false
            ? leaves(next.tree).flatMap((tile) => (sessionId(tile) ? [sessionId(tile) ?? ""] : []))
            : source
                .getSnapshot()
                .filter((row) => !(row.dormant && row.exited))
                .map((row) => row.id),
        );
        for (const id of startupIdsRef.current) sessions.add(id);
        const knownPreviews = previewIds(next);
        if (content.kind === "terminal") sessions.add(content.id);
        else knownPreviews.add(content.id);
        changeLayout(pruneContent(next, { sessions, previews: knownPreviews }));
        setFocusRequest((value) => value + 1);
      }
    });
    return () => {
      prepare();
      finish();
      movePendingRef.current = undefined;
      boardRef.current?.removeAttribute("inert");
    };
  }, [source, changeLayout, placementOptions, previewIds]);
  useEffect(
    () =>
      source.previews?.onPlace?.((id, expiresAt) => {
        if (
          movePendingRef.current ||
          Date.now() >= expiresAt ||
          !source.previews?.getSnapshot().some((preview) => preview.id === id)
        )
          return Promise.resolve("sidebar");
        const placed = placeAgentPreview(layoutRef.current, id, placementOptions());
        const manual =
          source.previews.getSnapshot().find((preview) => preview.id === id)?.worktree ===
          "foom:manual";
        if (manual) {
          const tile = leaves(placed.layout.tree).find(
            (leaf) => leaf.content?.kind === "preview" && leaf.content.preview === id,
          );
          if (tile) placed.layout = { ...placed.layout, focused: tile.id, maximized: null };
        }
        if (placed.layout !== layoutRef.current) {
          setArrivals((current) => new Set([...current, id]));
          changeLayout(placed.layout, true);
        }
        return Promise.resolve(placed.placement);
      }),
    [source, changeLayout, placementOptions],
  );
  useEffect(() => {
    if (source.isReady && !source.isReady()) return;
    const current = layoutRef.current;
    const knownPreviews = previewIds(current);
    // Remove a failed restore's saved assignment once. The warning may remain
    // on the row when the human later reveals or resumes that session.
    const failedRoles = new Set(
      rows
        .filter((row) => row.roleNotRestored && !unrestoredRolesRef.current.has(row.id))
        .map((row) => row.id),
    );
    for (const id of failedRoles) unrestoredRolesRef.current.add(id);
    const sessions = new Set(
      rows
        .filter((row) => !(row.dormant && row.exited) && !failedRoles.has(row.id))
        .map((row) => row.id),
    );
    if (
      leaves(current.tree).some((tile) =>
        tile.content?.kind === "preview"
          ? !knownPreviews.has(tile.content.preview)
          : sessionId(tile) && !sessions.has(sessionId(tile) ?? ""),
      )
    ) {
      const next = fitLayout(
        pruneContent(current, {
          sessions,
          previews: previewIds(current),
        }),
        measureTiles().metrics,
      );
      layoutRef.current = next;
      setLayout(next);
      try {
        saveLayout(localStorage, next, storageKey, [...startupLayoutsRef.current.values()]);
        clear("tile-layout");
      } catch {
        report("tile-layout", "Unable to save tile layout.");
      }
    }
  }, [source, rows, previews, previewIds, storageKey, clear, report, measureTiles]);
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
          previews: previewIds(layoutRef.current),
        }),
        true,
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
  }, [source, changeLayout, previews, previewIds]);
  const reservationRef = useRef<
    { source: BoardSource; layout: TileLayout; ids: string } | undefined
  >(undefined);
  useEffect(() => {
    if (movePendingRef.current || !source.windows || (source.isReady && !source.isReady())) return;
    const current = layout;
    const ids = leaves(current.tree).flatMap((tile) =>
      sessionId(tile) &&
      rows.some(
        (row) => row.id === sessionId(tile) && (!row.startup || row.startup.pending === false),
      )
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
        if (reservationRef.current === reservation) clear("terminal-views");
        if (layoutRef.current === current && ids.some((id) => !accepted.includes(id)))
          changeLayout(
            pruneContent(current, {
              sessions: new Set([
                ...accepted,
                ...rows
                  .filter((row) => row.startup && row.startup.pending !== false)
                  .map((row) => row.id),
              ]),
              previews: previewIds(current),
            }),
            true,
          );
      })
      .catch(() => {
        if (reservationRef.current === reservation) {
          reservationRef.current = undefined;
          report("terminal-views", "Unable to reserve terminal views.");
        }
      });
  }, [source, rows, previews, previewIds, layout, changeLayout, clear, report]);
  const tileAction = useCallback(
    (tile: string, action: Exclude<TileAction, "popout" | "new-shell">) => {
      const current = { ...layoutRef.current, focused: tile };
      if (
        action === "right" ||
        action === "left" ||
        action === "up" ||
        action === "down" ||
        action === "horizontal" ||
        action === "vertical"
      ) {
        const reason = splitReason(current, action, measureTiles().metrics);
        if (reason) {
          setSplitRefusal(reason);
          return;
        }
      }
      setFocusRequest((value) => value + 1);
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
          .catch((error: unknown) => {
            setRemoveError(errorMessage(error, "Unable to close session."));
          });
        return;
      }
      changeLayout(
        action === "grow-left" ||
          action === "grow-right" ||
          action === "grow-up" ||
          action === "grow-down"
          ? growTile(
              current,
              action === "grow-left"
                ? "left"
                : action === "grow-right"
                  ? "right"
                  : action === "grow-up"
                    ? "up"
                    : "down",
            )
          : action === "right" ||
              action === "down" ||
              action === "left" ||
              action === "up" ||
              action === "horizontal" ||
              action === "vertical"
            ? {
                ...splitTile(current, action, measureTiles().metrics),
                focused: layoutRef.current.focused,
              }
            : action === "close-space"
              ? closeSpace(layoutRef.current, tile)
              : action === "close"
                ? closeTile(current)
                : action === "hide"
                  ? hideSession(current)
                  : { ...current, maximized: current.maximized === tile ? null : tile },
      );
    },
    [changeLayout, source, measureTiles, setRemoveError],
  );
  return {
    otherViews,
    splitRefusal,
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
    completeStartup,
    failStartup,
    tileAction,
  };
}
