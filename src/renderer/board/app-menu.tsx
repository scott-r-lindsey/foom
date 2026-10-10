import { useCallback, useEffect, useRef, useState } from "react";
import type { AppMenuApi, AppMenuEntry, CommandItem, ShortcutGroup } from "../../shared/app-menu";
import { Chevron, RowMenu } from "./row-menu";
import { ShortcutSheet } from "./shortcut-sheet";
import type { RowAction } from "./row-menu";
/** Save focus and both form-control and document selections before menu buttons take focus. */
function captureFocus(): () => void {
  const target = document.activeElement;
  const input =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? target
      : undefined;
  const start = input?.selectionStart;
  const end = input?.selectionEnd;
  const direction = input?.selectionDirection;
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
  return () => {
    if (!(target instanceof HTMLElement) || !target.isConnected) return;
    target.focus({ preventScroll: true });
    if (input && start != null && end != null)
      input.setSelectionRange(start, end, direction ?? undefined);
    // A form selection is not a DOM Range. Restoring a collapsed document range
    // would clear the input caret/selection we just restored.
    if (range && !range.collapsed && range.commonAncestorContainer.isConnected) {
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  };
}
export function AppMenu({
  api,
  development,
}: {
  api?: AppMenuApi | undefined;
  development?: boolean | undefined;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [entries, setEntries] = useState<AppMenuEntry[]>();
  const [sheet, setSheet] = useState<ShortcutGroup[]>();
  const [error, setError] = useState("");
  const restoreFocusRef = useRef<() => void>(() => {});
  const restoreSheetFocusRef = useRef<() => void>(() => {});
  const generationRef = useRef({ value: 0 });
  const close = useCallback(() => {
    generationRef.current.value++;
    setEntries(undefined);
  }, []);
  /** Re-reads the projection; a stale reply never reopens a closed menu. */
  const load = useCallback(() => {
    if (!api) return;
    const current = ++generationRef.current.value;
    void api.commands().then(
      (next) => {
        if (current === generationRef.current.value) {
          setEntries(next);
          setError("");
        }
      },
      () => {
        setError("Unable to open application menu.");
      },
    );
  }, [api]);
  const open = useCallback(() => {
    // Reopening with Alt/F10 while already in the menu must retain its original target.
    if (
      !(document.activeElement instanceof Element) ||
      !document.activeElement.closest(".app-menu, .row-submenu")
    )
      restoreFocusRef.current = captureFocus();
    load();
  }, [load]);
  useEffect(() => {
    const generation = generationRef.current;
    const dispose = api?.onOpen(open);
    return () => {
      generation.value++;
      dispose?.();
    };
  }, [api, open]);
  useEffect(
    () =>
      api?.onShortcuts(() => {
        restoreSheetFocusRef.current = captureFocus();
        void api.shortcuts().then(setSheet, () => {
          setError("Unable to show keyboard shortcuts.");
        });
      }),
    [api],
  );
  const select = useCallback(
    (action: RowAction) => {
      close();
      restoreFocusRef.current();
      void action.run();
    },
    [close],
  );
  const wordmark = (
    <span aria-hidden="true">
      fo
      <span className="wordmark-hole" />m
    </span>
  );
  const command = (item: CommandItem, step = false): RowAction => ({
    label: item.label,
    hint: item.shortcut,
    disabled: !item.enabled,
    checked: item.checked,
    ...(item.badge ? { badge: item.badge } : {}),
    run: async () => {
      try {
        await api?.execute(item.id);
        if (step) load();
      } catch {
        setError(`Unable to run ${item.label}.`);
      }
    },
  });
  const actions = (entries ?? []).map((entry): RowAction | null => {
    if (!entry) return null;
    if (entry.kind === "submenu")
      return {
        label: entry.label,
        submenu: entry.items.map((item) => item && command(item)),
        run: () => undefined,
      };
    if (entry.kind === "size")
      return {
        label: entry.label,
        // The menu stays open; the row shows the size main settled on.
        stepper: {
          value: `${String(entry.scale)}%`,
          decrease: command(entry.smaller, true),
          increase: command(entry.bigger, true),
        },
        run: () => undefined,
      };
    return command(entry);
  });
  return (
    <>
      <h1 className="wordmark" aria-label={development ? "foom dev" : "foom"}>
        {api ? (
          <button
            ref={setAnchor}
            className="wordmark-menu"
            type="button"
            aria-label="Foom menu"
            aria-haspopup="menu"
            aria-expanded={Boolean(entries)}
            onPointerDown={(event) => {
              // Keep the edit target and its selection until open() captures them.
              if (event.button === 0) event.preventDefault();
            }}
            onClick={() => {
              if (entries) close();
              else open();
            }}
          >
            {wordmark}
            <Chevron direction="down" />
          </button>
        ) : (
          wordmark
        )}
        {development && <span className="dev-profile">Dev</span>}
      </h1>
      {entries && anchor && (
        <RowMenu
          anchor={anchor}
          actions={actions}
          close={close}
          placement="below"
          label="Foom"
          keepOnResize
          onAction={select}
        />
      )}
      {sheet && (
        <ShortcutSheet
          groups={sheet}
          close={() => {
            setSheet(undefined);
            restoreSheetFocusRef.current();
          }}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
