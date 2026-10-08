import { useCallback, useEffect, useRef, useState } from "react";
import type { AppMenuApi, CommandItem } from "../../shared/app-menu";
import { RowMenu } from "./row-menu";
import type { RowAction } from "./row-menu";
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
  const generationRef = useRef({ value: 0 });
  const close = useCallback(() => {
    generationRef.current.value++;
    setItems(undefined);
  }, []);
  const open = useCallback(() => {
    if (!api) return;
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
        await api?.execute(item.id);
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
        <RowMenu anchor={anchor} actions={actions} close={close} placement="below" label="Foom" />
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
