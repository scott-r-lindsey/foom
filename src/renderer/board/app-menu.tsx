import { useCallback, useEffect, useRef, useState } from "react";
import type { AppMenuApi, CommandItem } from "../../shared/app-menu";
import { RowMenu } from "./row-menu";
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
  const [items, setItems] = useState<CommandItem[]>();
  const [error, setError] = useState("");
  const restoreFocusRef = useRef<() => void>(() => {});
  const generationRef = useRef({ value: 0 });
  const close = useCallback(() => {
    generationRef.current.value++;
    setItems(undefined);
  }, []);
  const open = useCallback(() => {
    if (!api) return;
    // Reopening with Alt/F10 while already in the menu must retain its original target.
    if (
      !(document.activeElement instanceof Element) ||
      !document.activeElement.closest(".app-menu")
    )
      restoreFocusRef.current = captureFocus();
    const current = ++generationRef.current.value;
    void api.commands().then(
      (next) => {
        if (current === generationRef.current.value) {
          setItems(next);
          setError("");
        }
      },
      () => {
        setError("Unable to open application menu.");
      },
    );
  }, [api]);
  useEffect(() => {
    const generation = generationRef.current;
    const dispose = api?.onOpen(open);
    return () => {
      generation.value++;
      dispose?.();
    };
  }, [api, open]);
  const select = useCallback(
    (action: RowAction) => {
      close();
      restoreFocusRef.current();
      void action.run();
    },
    [close],
  );
  const wordmark = (
    <>
      <span aria-hidden="true">
        fo
        <span className="wordmark-hole" />m
      </span>
      {development && <span className="dev-profile">Dev</span>}
    </>
  );
  const actions: (RowAction | null)[] = [];
  let section = "";
  for (const item of items ?? []) {
    if (section && section !== item.section) actions.push(null);
    section = item.section;
    actions.push({
      label: item.label,
      hint: item.shortcut,
      disabled: !item.enabled,
      checked: item.checked,
      run: async () => {
        try {
          await api?.execute(item.id);
        } catch {
          setError(`Unable to run ${item.label}.`);
        }
      },
    });
  }
  return (
    <>
      <h1 className="wordmark" aria-label={development ? "foom dev" : "foom"}>
        {api && api.platform !== "darwin" ? (
          <button
            ref={setAnchor}
            className="wordmark-menu"
            type="button"
            aria-label="Foom menu"
            aria-haspopup="menu"
            aria-expanded={Boolean(items)}
            onPointerDown={(event) => {
              // Keep the edit target and its selection until open() captures them.
              if (event.button === 0) event.preventDefault();
            }}
            onClick={() => {
              if (items) close();
              else open();
            }}
          >
            {wordmark}
          </button>
        ) : (
          wordmark
        )}
      </h1>
      {items && anchor && (
        <RowMenu
          anchor={anchor}
          actions={actions}
          close={close}
          placement="below"
          label="Foom"
          onAction={select}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
