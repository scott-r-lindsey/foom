import { ActionError } from "../board/error-presentation";
import type { ReactNode } from "react";
import type { SetupSource } from "./setup-source.d";

const SETTINGS_SECTIONS = [
  { step: 11, label: "General" },
  { step: 1, label: "Agents" },
  { step: 12, label: "Forges" },
  { step: 10, label: "Environment" },
  { step: 2, label: "Repositories" },
  { step: 5, label: "Appearance" },
  { step: 6, label: "Terminal" },
  { step: 7, label: "Themes" },
  { step: 8, label: "Sound" },
  { step: 9, label: "Foom config" },
];

/** Settings navigation and controls frame shared by all setup sections. */
export function SettingsFrame({
  source,
  step,
  applying,
  onClose,
  go,
  error,
  dismissError,
  children,
}: {
  source: SetupSource;
  step: number;
  applying: boolean;
  onClose: (() => void) | undefined;
  go: (step: number) => void;
  error: string | undefined;
  dismissError: () => void;
  children: ReactNode;
}) {
  return (
    <section className="settings-view" aria-label="Settings">
      <button
        type="button"
        className="settings-close"
        aria-label="Close settings (Esc)"
        title="Close settings (Esc)"
        disabled={applying}
        onClick={onClose}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5 5 19 19M19 5 5 19" stroke="currentColor" strokeWidth="2" />
        </svg>
      </button>
      <nav className="settings-sections" aria-label="Settings sections">
        <h2>Settings</h2>
        {SETTINGS_SECTIONS.filter(
          (entry) =>
            ((entry.step !== 9 && entry.step !== 12) || source.config) &&
            (entry.step !== 10 || source.environment),
        ).map((entry) => (
          <button
            key={entry.step}
            type="button"
            aria-current={entry.step === step ? "page" : undefined}
            aria-label={entry.label}
            disabled={applying}
            onClick={() => {
              go(entry.step);
            }}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      <div className="settings-stage">
        <div className="settings-inner">
          <fieldset className="settings-controls" disabled={applying}>
            <legend className="visually-hidden">
              {SETTINGS_SECTIONS.find((entry) => entry.step === step)?.label}
            </legend>
            {children}
          </fieldset>
          {error && <ActionError message={error} close={dismissError} />}
        </div>
      </div>
    </section>
  );
}
