import { useState } from "react";
import { STEPS } from "./preflight";
import { pending } from "./repository-picker";
import type { useRepositorySelection } from "./use-repository-selection";

export function usePreflightNavigation(
  settingsMode: boolean,
  initialSection: "config" | undefined,
  closable: boolean,
  codeFolder: string | null,
  {
    code,
    codeScanning,
    repositories,
    scanCode,
    applySelection,
  }: Pick<
    ReturnType<typeof useRepositorySelection>,
    "code" | "codeScanning" | "repositories" | "scanCode" | "applySelection"
  >,
  setError: (error: string | undefined) => void,
) {
  const [step, setStep] = useState(settingsMode ? (initialSection === "config" ? 9 : 11) : 0);
  const [reached, setReached] = useState(closable ? STEPS.length - 1 : 0);
  const move = (next: number) => {
    setStep(next);
    setReached((current) => Math.max(current, next));
    setError(undefined);
    // Arriving at Repositories with a saved folder shows what's in it now.
    if (next === 2 && !code && !codeScanning && codeFolder) scanCode(codeFolder);
  };
  /** Leaving Repositories saves the selection first; a refusal keeps you there. */
  const go = (next: number) => {
    if (step !== 2 || next === 2 || !code || !pending(code, repositories)) {
      move(next);
      return;
    }
    void applySelection(code).then((ok) => {
      if (ok) move(next);
    });
  };
  return { step, reached, go };
}
