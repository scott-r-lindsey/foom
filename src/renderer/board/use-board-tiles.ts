import { readPreferences } from "./sidebar-preferences";
import { errorMessage } from "../../shared/application-errors";
import { prepareMove, finishMove } from "./move-placement";
import { useBackgroundErrors } from "./error-presentation";
import { useCallback, useEffect, useRef, useState } from "react";
import { TERMINAL_FONT_FALLBACK, terminalFontStack } from "../../shared/terminal-fonts";
import type { PreviewSummary } from "../../shared/workspace";
import type { SetupSource } from "../preflight/setup-source.d";
import type { BoardSource } from "./board-source.d";
import type { BoardRow } from "./board.d";
import {
  closeTile,
  closeSpace,
  growTile,
  hideSession,
  leaves,
  loadLayout,
  placeAgentPreview,
  pruneContent,
  restoreLayout,
  saveLayout,
  sessionId,
  splitTile,
} from "./tiles";
import type { TileAction, TileLayout } from "./tiles.d";

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
      return loadLayout(localStorage, storageKey, readPreferences(localStorage).expanded);
    } catch {
      return restoreLayout(null);
    }
  });
  const boardRef = useRef<HTMLDivElement>(null);
  const fontSizeRef = useRef(14);
  const fontFamilyRef = useRef(TERMINAL_FONT_FALLBACK);
  const focusedAtRef = useRef(new Map<string, number>());
  const focusClockRef = useRef(0);
  const unrestoredRolesRef = useRef(new Set<string>());
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
  const [focusRequest, setFocusRequest] = useState(0);
  const changeLayout = useCallback(
    (next: TileLayout, background = false) => {
      if (movePendingRef.current) return;
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
      layoutRef.current = next;
      setLayout(next);
      try {
        saveLayout(localStorage, next, storageKey);
        clear("tile-layout");
      } catch {
        report("tile-layout", "Unable to save tile layout.");
      }
    },
    [storageKey, source, clear, report],
  );
  const placementOptions = useCallback(() => {
    const area = boardRef.current?.querySelector(".tile-area");
    const probe = document.createElement("span");
    probe.style.cssText = `position:absolute;visibility:hidden;font:${String(fontSizeRef.current)}px ${fontFamilyRef.current}`;
    probe.textContent = "M";
    boardRef.current?.append(probe);
    const cell = probe.getBoundingClientRect().width || fontSizeRef.current * 0.6;
    probe.remove();
    return {
      columns: (area?.getBoundingClientRect().width ?? 0) / cell,
      needsYou: new Set(
        source
          .getSnapshot()
          .filter((row) => row.state === "needs_input")
          .map((row) => row.id),
      ),
      focusedAt: focusedAtRef.current,
    };
  }, [source]);
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
      const next = pruneContent(current, {
        sessions,
        previews: previewIds(current),
      });
      layoutRef.current = next;
      setLayout(next);
      try {
        saveLayout(localStorage, next, storageKey);
        clear("tile-layout");
      } catch {
        report("tile-layout", "Unable to save tile layout.");
      }
    }
  }, [source, rows, previews, previewIds, storageKey, clear, report]);
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
        if (reservationRef.current === reservation) clear("terminal-views");
        if (layoutRef.current === current && ids.some((id) => !accepted.includes(id)))
          changeLayout(
            pruneContent(current, {
              sessions: new Set(accepted),
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
            ? { ...splitTile(current, action), focused: layoutRef.current.focused }
            : action === "close-space"
              ? closeSpace(layoutRef.current, tile)
              : action === "close"
                ? closeTile(current)
                : action === "hide"
                  ? hideSession(current)
                  : { ...current, maximized: current.maximized === tile ? null : tile },
      );
    },
    [changeLayout, source],
  );
  return {
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
  };
}
