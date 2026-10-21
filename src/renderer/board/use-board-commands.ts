import { useEffect, useEffectEvent } from "react";
import { nextWaiting } from "./board";
import type { BoardCommandContext } from "./board-commands.d";
import { rowRepository } from "./sidebar-model";
import { neighbor, swapTiles, terminals, tidyTiles } from "./tiles";

export function useBoardCommands({
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
}: BoardCommandContext): void {
  const runSidebarCommand = useEffectEvent(command);
  useEffect(
    () =>
      source.subscribeCommands?.((command) => {
        if (inactive || command === "about") return;
        if (command.startsWith("via-")) {
          void runSidebarCommand({ kind: "config-launch", run: command.slice(4) });
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
    ],
  );
}
