import type { Settings } from "../shared/setup";

const MODES = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;
// Mirrors SCALES in src/appearance.ts, which main validates against.
const SCALES = [80, 90, 100, 110, 120, 130, 140, 150];
const shortcutHint = () =>
  navigator.platform.startsWith("Mac") ? "⌘ + / − / 0" : "Ctrl+Shift+= / − · Ctrl+0";

/** Light or dark, and the interface size. Both apply at once and are saved. */
export function AppearanceControls({
  settings,
  onChange,
}: {
  settings: Pick<Settings, "colorMode" | "interfaceScale">;
  onChange: (patch: Partial<Pick<Settings, "colorMode" | "interfaceScale">>) => void;
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
  return (
    <div className="appearance">
      <fieldset className="appearance-mode">
        <legend>Appearance</legend>
        {MODES.map((mode) => (
          <label key={mode.id}>
            <input
              type="radio"
              name="color-mode"
              checked={settings.colorMode === mode.id}
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
        <output aria-live="polite">{scale}%</output>
        <button
          type="button"
          aria-label="Larger"
          disabled={larger === undefined}
          onClick={to(larger)}
        >
          +
        </button>
        {scale !== 100 && (
          <button
            type="button"
            className="link"
            onClick={() => {
              onChange({ interfaceScale: 100 });
            }}
          >
            Reset
          </button>
        )}
      </div>
      <p className="appearance-hint">{shortcutHint()}</p>
    </div>
  );
}
