import type { Repository } from "../../shared/worktrees";
import { QueryClient, useQuery, notifyManager } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DataView, DataViewApi, DataViews, ViewParams } from "../../shared/data-views";

// Main already coalesces publications. Deliver cache notifications in the same turn.
notifyManager.setScheduler((notify) => {
  notify();
});
const EMPTY_SOURCE = {};
export interface ViewSource {
  views?: DataViewApi;
}
const owners = new WeakMap<object, number>();
let ownerSequence = 0;
const viewClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
});
const subscriptions = new WeakMap<DataViewApi, Map<string, { refs: number; off: () => void }>>();
function ownerKey(owner: object): number {
  let id = owners.get(owner);
  if (id === undefined) {
    id = ++ownerSequence;
    owners.set(owner, id);
  }
  return id;
}
/** Keep page snapshots separate until every page describes the same view revision. */
function repositoryPages(api: DataViewApi, client: QueryClient, cachePrefix: number): () => void {
  const pages = new Map<number, { rows: readonly Repository[]; revision: number; next?: number }>();
  const releases = new Map<number, () => void>();
  const cursors = new Map<number, { generation: number; revision: number }>();
  let active = true;
  const key = [cachePrefix, "repositories", {}];
  const request = (offset: number) => {
    if (releases.has(offset)) return;
    let pageActive = true;
    const off = api.subscribeView("repositories", { offset, limit: 100 }, (snapshot) => {
      if (!active || !pageActive) return;
      const previous = cursors.get(offset);
      if (
        previous &&
        (previous.generation !== snapshot.generation || previous.revision >= snapshot.revision)
      )
        return;
      cursors.set(offset, snapshot);
      if (snapshot.error) {
        client
          .getQueryCache()
          .find({ queryKey: key, exact: true })
          ?.setState({ status: "error", error: new Error("Unable to load repositories") });
        return;
      }
      pages.set(offset, {
        rows: snapshot.data,
        revision: snapshot.viewRevision ?? snapshot.revision,
        ...(snapshot.nextOffset === undefined ? {} : { next: snapshot.nextOffset }),
      });
      client.setQueryData([cachePrefix, "repositories", { offset, limit: 100 }], snapshot.data);
      if (snapshot.nextOffset !== undefined) request(snapshot.nextOffset);
      else
        for (const [after, release] of releases)
          if (after > offset) {
            release();
            releases.delete(after);
            pages.delete(after);
            cursors.delete(after);
          }
      const rows: Repository[] = [];
      let at: number | undefined = 0;
      while (at !== undefined) {
        const page = pages.get(at);
        if (!page || page.revision !== (snapshot.viewRevision ?? snapshot.revision)) return;
        rows.push(...page.rows);
        at = page.next;
      }
      client.setQueryData(key, rows);
    });
    releases.set(offset, () => {
      pageActive = false;
      off();
    });
  };
  request(0);
  return () => {
    active = false;
    for (const release of releases.values()) release();
  };
}
function retain(
  api: DataViewApi,
  client: QueryClient,
  cachePrefix: number,
  view: DataView,
  params: ViewParams,
): () => void {
  let entries = subscriptions.get(api);
  if (!entries) {
    entries = new Map();
    subscriptions.set(api, entries);
  }
  const key = JSON.stringify([view, params]);
  let entry = entries.get(key);
  if (!entry) {
    let generation: number | undefined;
    let revision = -1;
    const off =
      view === "repositories" && params.offset === undefined
        ? repositoryPages(api, client, cachePrefix)
        : api.subscribeView(view, params, (snapshot) => {
            if (generation !== undefined && generation !== snapshot.generation) return;
            if (snapshot.revision <= revision) return;
            generation = snapshot.generation;
            revision = snapshot.revision;
            const queryKey = [cachePrefix, view, params];
            if (snapshot.error)
              client
                .getQueryCache()
                .find({ queryKey, exact: true })
                ?.setState({ status: "error", error: new Error("Unable to load view") });
            else client.setQueryData(queryKey, snapshot.data);
          });
    entry = { refs: 0, off };
    entries.set(key, entry);
  }
  entry.refs++;
  const retained = entry;
  return () => {
    if (--retained.refs === 0) {
      retained.off();
      entries.delete(key);
    }
  };
}
/** Legacy sample sources use the same cache, with their existing typed readers. */
export function useView<K extends DataView>(
  source: ViewSource | undefined,
  view: K,
  read: () => Promise<DataViews[K]>,
  initial?: DataViews[K],
  params: ViewParams = {},
  active = true,
) {
  const api = source?.views;
  const client = viewClient;
  const cachePrefix = ownerKey(api ?? source ?? EMPTY_SOURCE);
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);
  const { offset, limit, repository, machine } = params;
  const normalized = useMemo(
    () => ({
      ...(offset === undefined ? {} : { offset }),
      ...(limit === undefined ? {} : { limit }),
      ...(repository === undefined ? {} : { repository }),
      ...(machine === undefined ? {} : { machine }),
    }),
    [offset, limit, repository, machine],
  );
  const key = [cachePrefix, view, normalized];
  const query = useQuery(
    {
      queryKey: key,
      queryFn: async ({ signal }) => {
        const value = await read();
        signal.throwIfAborted();
        return value;
      },
      enabled: active && !api,
      ...(initial === undefined ? {} : { initialData: initial }),
    },
    client,
  );
  useEffect(
    () => (api && active ? retain(api, client, cachePrefix, view, normalized) : undefined),
    [api, client, cachePrefix, view, normalized, active],
  );
  useEffect(
    () => () => {
      const queryKey = [cachePrefix, view, normalized];
      if (client.getQueryCache().find({ queryKey, exact: true })?.getObserversCount() === 0)
        client.removeQueries({ queryKey, exact: true });
    },
    [client, cachePrefix, view, normalized],
  );
  const setData: Dispatch<SetStateAction<DataViews[K] | undefined>> = useCallback(
    (next) => {
      // Write replies acknowledge the command. Only ordered pushes update live truth.
      if (!api && activeRef.current) client.setQueryData([cachePrefix, view, normalized], next);
    },
    [api, client, cachePrefix, view, normalized],
  );
  return { ...query, setData };
}
export const useSettingsView = (
  source: ViewSource | undefined,
  read: () => Promise<DataViews["settings"]>,
  initial?: DataViews["settings"],
) => useView(source, "settings", read, initial);
export const useHostsView = (
  source: ViewSource | undefined,
  read: () => Promise<DataViews["hosts"]>,
) => useView(source, "hosts", read);
export const useAgentsView = (
  source: ViewSource | undefined,
  read: () => Promise<DataViews["agents"]>,
) => useView(source, "agents", read, undefined, { machine: "local" });
export const useRepositoriesView = (
  source: ViewSource | undefined,
  read: () => Promise<DataViews["repositories"]>,
) => useView(source, "repositories", read);
export const useWorktreesView = (
  source: ViewSource | undefined,
  repository: string,
  read: () => Promise<DataViews["worktrees"]>,
) => useView(source, "worktrees", read, undefined, { repository });
export const useSessionsView = (
  source: ViewSource | undefined,
  read: () => Promise<DataViews["sessions"]>,
) => useView(source, "sessions", read);
export const useEnvironmentView = (
  source: ViewSource | undefined,
  read: () => Promise<DataViews["environment"]>,
) => useView(source, "environment", read);
export const useConfigView = (
  source: ViewSource | undefined,
  read: () => Promise<DataViews["config"]>,
) => useView(source, "config", read);

function updater<T>(next: SetStateAction<T>): next is (previous: T) => T {
  return typeof next === "function";
}
/** Compatibility for existing command handlers; live replies never overwrite pushed data. */
export function useViewState<T>(
  query: { data: T | undefined; setData: Dispatch<SetStateAction<T | undefined>> },
  fallback: T,
): [T, Dispatch<SetStateAction<T>>] {
  const setData = query.setData;
  const update: Dispatch<SetStateAction<T>> = useCallback(
    (next) => {
      setData((previous) => (updater(next) ? next(previous ?? fallback) : next));
    },
    [setData, fallback],
  );
  return [query.data ?? fallback, update];
}

export const useFontsView = (
  source: ViewSource | undefined,
  read: () => Promise<DataViews["fonts"]>,
) => useView(source, "fonts", read);
export const useSoundsView = (
  source: ViewSource | undefined,
  read: () => Promise<DataViews["sounds"]>,
) => useView(source, "sounds", read);
export const useReadinessView = (
  source: ViewSource | undefined,
  read: () => Promise<DataViews["readiness"]>,
  active: boolean,
) => useView(source, "readiness", read, undefined, {}, active);

export const useMachineAgentsView = (
  source: ViewSource | undefined,
  machine: string,
  active: boolean,
) =>
  useView(
    source,
    "agents",
    () => Promise.reject(new Error("Unavailable")),
    undefined,
    { machine },
    active,
  );
