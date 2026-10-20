import { useEffect, useState } from "react";
import type { BoardSource, LaunchOptions } from "./board-source.d";

export function useBoardOptions(
  source: BoardSource,
  inactive: boolean,
  settingsOpen: boolean,
): LaunchOptions | undefined {
  const [options, setOptions] = useState<LaunchOptions>();
  useEffect(() => {
    let revision = 0;
    const load = () => {
      const request = ++revision;
      void source.worktrees?.load().then(
        (next) => {
          if (request === revision) setOptions(next);
        },
        () => {},
      );
    };
    const unsubscribe = source.worktrees?.subscribe?.(load);
    load();
    return () => {
      revision++;
      unsubscribe?.();
    };
  }, [source, inactive, settingsOpen]);
  return options;
}
