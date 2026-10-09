import { resolveInterfaceTheme } from "../../shared/interface-themes";
import { useRef } from "react";
import type { Settings } from "../../shared/setup";

const MODES = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;
/** Scrolling this far changes the size one step: a mouse notch, or a short trackpad swipe. */
const WHEEL_STEP = 50;
// Mirrors SCALES in src/main/window/appearance.ts, which main validates against.
const SCALES = [80, 90, 100, 110, 120, 130, 140, 150];
const shortcutHint = () =>
  navigator.platform.startsWith("Mac") ? "⌘ + / − / 0" : "Ctrl+Shift+= / − / 0";

/** Light or dark, and the interface size. Both apply at once and are saved. */
export function AppearanceControls({
  settings,
  onChange,
}: {
  settings: Pick<Settings, "colorMode" | "interfaceScale"> &
    Partial<Pick<Settings, "interfaceTheme" | "panelColor">>;
  onChange: (patch: Partial<Pick<Settings, "colorMode" | "interfaceScale" | "panelColor">>) => void;
}) {
  const scale = settings.interfaceScale;
  const smaller = SCALES.findLast((step) => step < scale);
  const larger = SCALES.find((step) => step > scale);
  // At either end the button is disabled and has nothing to do.
  const to = (next: number | undefined) =>
    next === undefined
      ? undefined
      : () => {
          onChange({ interfaceScale: next });
        };
  // Trackpads send many small deltas; they add up to a step.
  const wheelRef = useRef(0);
  return (
    <div className="appearance">
      <fieldset className="appearance-mode">
        <legend>Appearance</legend>
        {MODES.map((mode) => (
          <label key={mode.id}>
            <input
              type="radio"
              name="color-mode"
              checked={
                (settings.interfaceTheme === undefined || settings.interfaceTheme === "follow") &&
                settings.colorMode === mode.id
              }
              onChange={() => {
                onChange({ colorMode: mode.id });
              }}
            />
            <span>{mode.label}</span>
          </label>
        ))}
      </fieldset>
      <div className="appearance-size" role="group" aria-label="Interface size">
        <span aria-hidden="true">Size</span>
        <button
          type="button"
          aria-label="Smaller"
          disabled={smaller === undefined}
          onClick={to(smaller)}
        >
          −
        </button>
        {/* Scrolling over the size changes it too; the buttons do the same by keyboard. */}
        <output
          aria-live="polite"
          onWheel={(event) => {
            // Line and page modes come from mouse wheels: each event is a notch.
            wheelRef.current += event.deltaMode === 0 ? event.deltaY : event.deltaY * WHEEL_STEP;
            if (Math.abs(wheelRef.current) < WHEEL_STEP) return;
            const next = wheelRef.current < 0 ? larger : smaller;
            wheelRef.current = 0;
            if (next !== undefined) onChange({ interfaceScale: next });
          }}
        >
          {scale}%
        </output>
        <button
          type="button"
          aria-label="Larger"
          disabled={larger === undefined}
          onClick={to(larger)}
        >
          +
        </button>
      </div>
      {settings.interfaceTheme && settings.interfaceTheme !== "follow" && (
        <p className="appearance-hint">
          Theme: {resolveInterfaceTheme(settings.interfaceTheme, false).name}
        </p>
      )}
      <p className="appearance-hint">{shortcutHint()}</p>
      <fieldset className="appearance-mode">
        <legend>Panel color</legend>
        {(["vivid", "subtle", "plain"] as const).map((level) => (
          <label key={level}>
            <input
              type="radio"
              name="panel-color"
              checked={(settings.panelColor ?? "vivid") === level}
              onChange={() => {
                onChange({ panelColor: level });
              }}
            />
            <span>
              {level[0]?.toUpperCase()}
              {level.slice(1)}
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
