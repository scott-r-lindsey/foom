import { useId } from "react";
import type { TileAction, TileDirection, TileLayout } from "./tiles.d";
import { growTarget, splitReason } from "./tiles";

const arrows = {
  up: "M7 11V3M3.5 6.5 7 3l3.5 3.5",
  down: "M7 3v8M3.5 7.5 7 11l3.5-3.5",
  left: "M11 7H3M6.5 3.5 3 7l3.5 3.5",
  right: "M3 7h8M7.5 3.5 11 7l-3.5 3.5",
};
const shapes = {
  up: "14,1 27,7 27,27 1,27 1,7",
  down: "1,1 27,1 27,21 14,27 1,21",
  left: "1,14 7,1 27,1 27,27 7,27",
  right: "1,1 21,1 27,14 21,27 1,27",
};
const keys: Readonly<Record<string, TileDirection>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};
export function DirectionPad({
  kind,
  layout,
  run,
}: {
  kind: "Split" | "Grow";
  layout: TileLayout;
  run: (value: TileAction) => void;
}) {
  const id = useId();
  return (
    <div
      className="direction-pad"
      role="group"
      aria-label={kind}
      onKeyDown={(event) => {
        const direction = keys[event.key];
        if (!direction) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget
          .querySelector<HTMLButtonElement>(`[data-direction="${direction}"] button`)
          ?.focus();
      }}
    >
      <span className="pad-label">{kind}</span>
      <div className="pad-grid">
        {(["right", "up", "left", "down"] as const).map((direction) => {
          const target = kind === "Grow" ? growTarget(layout, direction) : undefined;
          const reason =
            kind === "Split"
              ? splitReason(layout)
              : target && "reason" in target
                ? target.reason
                : undefined;
          return (
            <span className="pad-direction" data-direction={direction} key={direction}>
              <button
                type="button"
                role="menuitem"
                aria-label={`${kind} ${direction}`}
                aria-disabled={Boolean(reason)}
                aria-describedby={reason ? `${id}-${direction}` : undefined}
                onClick={() => {
                  if (!reason) run(kind === "Split" ? direction : `grow-${direction}`);
                }}
              >
                <svg className="pad-shape" viewBox="0 0 28 28" aria-hidden="true">
                  <polygon points={shapes[direction]} />
                </svg>
                <svg className="pad-arrow" viewBox="0 0 14 14" aria-hidden="true">
                  <path d={arrows[direction]} />
                </svg>
              </button>
              {reason && (
                <span className="pad-reason" role="tooltip" id={`${id}-${direction}`}>
                  {reason}
                </span>
              )}
            </span>
          );
        })}
        <span className="pad-center" aria-hidden="true">
          <svg viewBox="0 0 14 14">
            <path
              d={
                kind === "Split" ? "M2 2.5h10v9H2zM7 2.5v9" : "M2 2.5h10v9H2zM4.5 7h5M7.5 5l2 2-2 2"
              }
            />
          </svg>
        </span>
      </div>
    </div>
  );
}
