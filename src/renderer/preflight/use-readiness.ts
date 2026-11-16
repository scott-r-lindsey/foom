import { useCallback, useMemo, useState } from "react";
import { useReadinessView, useConfigView } from "../data/view-hooks";
import type { SetupSource } from "./setup-source.d";

export function useReadiness(
  source: Pick<SetupSource, "checkReadiness" | "config" | "views">,
  active: boolean,
  revision: string,
) {
  const viewSource = useMemo(
    () => (source.views ? source : { ...source }),
    [source, revision, active],
  );
  const query = useReadinessView(
    viewSource,
    () => source.checkReadiness?.() ?? Promise.reject(new Error("Unavailable")),
    active && !!source.checkReadiness,
  );
  const catalog = useConfigView(
    source.config,
    () => source.config?.status() ?? Promise.reject(new Error("Unavailable")),
  );
  const commands = new Map(
    (catalog.data?.forgePlugins ?? [])
      .filter((forge) => !forge.reason)
      .flatMap((forge) => {
        const executable = forge.executables.find((name) => name === "gh" || name === "glab");
        return executable ? [[forge.id, `${executable} auth login`] as const] : [];
      }),
  );
  const [checking, setChecking] = useState(false);
  const refetch = query.refetch;
  const recheck = useCallback(() => {
    if (source.views) {
      setChecking(true);
      void source
        .checkReadiness?.()
        .catch(() => undefined)
        .finally(() => {
          setChecking(false);
        });
    } else void refetch();
  }, [source, refetch]);
  return {
    report: query.data,
    busy: checking || query.isFetching || (active && query.isPending),
    error: query.isError,
    recheck,
    commands,
  };
}
