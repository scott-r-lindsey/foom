import { PanelMark, CommandGlyph } from "../board/panel-glyphs";
import type { ThemeCatalog } from "../../shared/theme-file";
import { resolveInterfaceTheme } from "../../shared/interface-themes";
import { useWheelNotch } from "../wheel-notch";
import type { Settings } from "../../shared/setup";
import { SCALES } from "../../shared/config-settings";

const MODES = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;
const shortcutHint = () =>
  navigator.platform.startsWith("Mac") ? "⌘ + / − / 0" : "Ctrl+Shift+= / − / 0";

/** Light or dark, and the interface size. Both apply at once and are saved. */
export function AppearanceControls({
  settings,
  onChange,
  catalog,
}: {
  catalog?: ThemeCatalog | undefined;
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
  const wheelNotch = useWheelNotch();
  return (
    <div className="appearance">
      <div className="appearance-group">
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
              const direction = wheelNotch(event);
              if (!direction) return;
              const next = direction > 0 ? larger : smaller;
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
            Theme: {resolveInterfaceTheme(settings.interfaceTheme, false, catalog).name}
          </p>
        )}
        <p className="appearance-hint">{shortcutHint()}</p>
      </div>
      <div className="appearance-panel-group">
        <fieldset className="appearance-mode">
          <legend>Session panel color</legend>
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
        <div
          className="row-menu sidebar-panel session-panel-preview"
          role="img"
          aria-label="Session panel preview"
        >
          <header className="panel-header">
            <PanelMark mark="CC" />
            <div className="panel-title">Claude Code</div>
            <span className="panel-kind">Session</span>
          </header>
          <div className="panel-body">
            <div className="row-menu-items">
              <span className="preview-command">
                <CommandGlyph name="hide" />
                Hide
              </span>
            </div>
            <div className="panel-facts">
              <span className="panel-chip" data-tone="working">
                Working
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
