import { useCallback, useEffect, useState } from "react";
import type { ReadinessReport } from "../../shared/readiness";
import type { SetupSource } from "./setup-source.d";

export function useReadiness(
  source: Pick<SetupSource, "checkReadiness" | "config">,
  active: boolean,
  revision: string,
) {
  const [commands, setCommands] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [report, setReport] = useState<ReadinessReport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [request, setRequest] = useState(0);
  const recheck = useCallback(() => {
    setRequest((value) => value + 1);
  }, []);
  useEffect(() => {
    if (!active || !source.checkReadiness) return;
    let live = true;
    if (source.config)
      void source.config.status().then(
        (catalog) => {
          if (live)
            setCommands(
              new Map(
                (catalog.forgePlugins ?? [])
                  .filter((forge) => !forge.reason)
                  .flatMap((forge) => {
                    const executable = forge.executables.find(
                      (name) => name === "gh" || name === "glab",
                    );
                    return executable ? [[forge.id, `${executable} auth login`] as const] : [];
                  }),
              ),
            );
        },
        () => {},
      );
    setBusy(true);
    setReport(undefined);
    setError(false);
    void source
      .checkReadiness()
      .then(
        (next) => {
          if (live) setReport(next);
        },
        () => {
          if (live) setError(true);
        },
      )
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [source, active, revision, request]);
  return { report, busy, error, recheck, commands };
}
