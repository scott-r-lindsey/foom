import { restoreBoardFocus } from "./board/focus-restore";
import { LegalDialog } from "./about/legal-dialog";
import type { LegalDocument } from "../shared/app-menu";
import { AboutDialog } from "./about/about-dialog";
import { ActionError, ErrorPresentation } from "./board/error-presentation";
import { attachPreviewComposition } from "./board/preview-composition";
import { attachInterfaceTheme } from "./ui/interface-theme";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SetupState } from "../shared/setup";
import { Board } from "./board/board-view";
import { createSampleSource } from "./board/sample-board-source";
import { createAppSource } from "./board/live-board-source";
import { Preflight } from "./preflight/preflight-view";
import { createSetupSource } from "./preflight/setup-source";

function showConfirmationScrim(element: HTMLDivElement | null): void {
  element?.showPopover();
}

/**
 * Preflight runs until setup is complete; later changes live in Settings.
 * Once mounted, the board stays mounted underneath so its shell keeps running.
 */
export function App() {
  return (
    <ErrorPresentation>
      <AppContents />
    </ErrorPresentation>
  );
}
function AppContents() {
  const [legal, setLegal] = useState<{ id: LegalDocument; version: number }>();
  useEffect(
    () =>
      window.desktop.appMenu.onLegal((id) => {
        setLegal((current) => ({ id, version: (current?.version ?? 0) + 1 }));
      }),
    [],
  );
  const [about, setAbout] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [source] = useState(() =>
    typeof FOOM_SAMPLE_BOARD !== "undefined" && FOOM_SAMPLE_BOARD
      ? createSampleSource()
      : createAppSource(),
  );
  useEffect(
    () =>
      source.subscribeCommands?.((command) => {
        if (command === "about") setAbout(true);
      }),
    [source],
  );
  useEffect(() => {
    const api = window.desktop.previews;
    if (api) return attachPreviewComposition(api);
  }, []);
  const [scrim, setScrim] = useState({ visible: false });
  const scrimOriginRef = useRef<{ target: Element | null } | undefined>(undefined);
  useLayoutEffect(() => {
    if (scrim.visible) return;
    const origin = scrimOriginRef.current;
    scrimOriginRef.current = undefined;
    // Remove the top-layer popover before restoring input: its native focus
    // cleanup can otherwise overwrite the fallback with body on Windows/macOS.
    if (!origin) return;
    restoreBoardFocus(origin.target);
    // Windows can finish native focus cleanup after the commit. Repair only
    // an empty focus target after the first paint; retain a person's new selection.
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        if (document.activeElement === document.body) restoreBoardFocus(origin.target);
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [scrim]);
  useEffect(() => {
    let showing = false;
    return source.confirmations?.onScrim?.((visible) => {
      if (visible === showing) return;
      if (visible && scrimOriginRef.current === undefined)
        scrimOriginRef.current = { target: document.activeElement };
      // A batched true/false pair must still commit its dismissal effect.
      setScrim({ visible });
      showing = visible;
    });
  }, [source]);
  const [setup] = useState(createSetupSource);
  useEffect(() => attachInterfaceTheme(setup), [setup]);
  const [state, setState] = useState<SetupState>();
  const [preflight, setPreflight] = useState(false);
  const [settings, setSettings] = useState(false);
  const [section, setSection] = useState<{ name?: "config"; version: number }>({ version: 0 });
  const [board, setBoard] = useState(false);
  useEffect(() => {
    setup.state().then(
      (initial) => {
        setState(initial);
        if (initial.settings.setupComplete) setBoard(true);
        else setPreflight(true);
      },
      (error: unknown) => {
        // Settings are unreadable: the board still works with defaults.
        console.error("Unable to load setup:", error);
        setBoard(true);
      },
    );
  }, [setup]);
  const reopen = async (name?: "config") => {
    setSection((current) => ({ ...(name ? { name } : {}), version: current.version + 1 }));
    try {
      setState(await setup.state());
      setSettings(true);
    } catch {
      setActionError(true);
    }
  };
  return (
    <>
      {about && (
        <AboutDialog
          menu={window.desktop.appMenu}
          close={() => {
            setAbout(false);
          }}
        />
      )}
      {legal && (
        <LegalDialog
          key={legal.version}
          id={legal.id}
          menu={window.desktop.appMenu}
          close={() => {
            setLegal(undefined);
          }}
        />
      )}
      {actionError && (
        <ActionError
          message="Unable to open Settings."
          close={() => {
            setActionError(false);
          }}
        />
      )}
      {preflight && state && (
        <Preflight
          source={setup}
          initial={state}
          onLaunched={(next) => {
            setState(next);
            setPreflight(false);
            setBoard(true);
          }}
        />
      )}
      {board && (
        <Board
          source={source}
          soundSetup={setup}
          inactive={preflight}
          onSettings={(name) => {
            if (!settings || name) void reopen(name);
          }}
          onCloseSettings={() => {
            setSettings(false);
          }}
          settingsView={
            settings && state ? (
              <Preflight
                key={section.version}
                source={setup}
                initial={state}
                settingsMode
                {...(section.name ? { initialSection: section.name } : {})}
                onLaunched={setState}
                onClose={() => {
                  setSettings(false);
                }}
              />
            ) : undefined
          }
        />
      )}
      {scrim.visible && (
        <div
          className="board-confirmation-scrim"
          aria-hidden="true"
          popover="manual"
          ref={showConfirmationScrim}
        />
      )}
    </>
  );
}
