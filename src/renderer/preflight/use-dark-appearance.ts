import { useCallback, useState, useSyncExternalStore } from "react";

/** Recheck native appearance after subscribing, including changes during a React commit. */
export function useDarkAppearance(): boolean {
  const [media] = useState(() => matchMedia("(prefers-color-scheme: dark)"));
  const subscribe = useCallback(
    (changed: () => void) => {
      media.addEventListener("change", changed);
      return () => {
        media.removeEventListener("change", changed);
      };
    },
    [media],
  );
  const snapshot = useCallback(() => media.matches, [media]);
  return useSyncExternalStore(subscribe, snapshot);
}
