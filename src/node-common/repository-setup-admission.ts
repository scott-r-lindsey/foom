import { setupSelectedTools } from "../shared/repository-setup-catalog";
import type { SetupAdmission } from "../shared/repository-setup.d";
import { setupCatalogDigest } from "./repository-setup-digest";
import { inspectSetupSources } from "./repository-setup-sources";
import {
  checkSetupList,
  repositorySetupEnvironment,
  withSetupProbeDependencies,
} from "./repository-setup-check";
import { LaunchFailure } from "../shared/launch-failure";
/** Re-run on the execution host; a peer cannot turn a hub observation into spawn authority. */
export async function validateSetupAdmission(
  admission: SetupAdmission | undefined,
  checkout: string,
  prefix: string,
  source: NodeJS.ProcessEnv,
  home: string,
  signal?: AbortSignal,
): Promise<Record<string, string> | undefined> {
  if (!admission) return undefined;
  if (admission.catalog !== setupCatalogDigest) throw new LaunchFailure("repository_setup_changed");
  const paths = [
    ...new Set([
      ...admission.list.evidence,
      ...admission.list.requirements.flatMap((item) => item.sources),
    ]),
  ];
  const sources = await inspectSetupSources(checkout, paths).catch(() => {
    throw new LaunchFailure("repository_setup_unavailable");
  });
  if (sources.fingerprint !== admission.sources)
    throw new LaunchFailure("repository_setup_changed");
  const env = await repositorySetupEnvironment(
    source,
    [admission.codeRoot, checkout],
    prefix,
    setupSelectedTools(admission.list),
    home,
  );
  const checked = await withSetupProbeDependencies(
    env,
    home,
    signal,
    [admission.codeRoot, checkout],
    (deps) => checkSetupList(admission.list, deps),
  );
  if (checked.items.some((item) => item.state !== "met"))
    throw new LaunchFailure(
      checked.items.some((item) => item.state === "unable")
        ? "repository_setup_unavailable"
        : checked.items.some((item) => item.state === "manual")
          ? "repository_setup_manual"
          : "repository_setup_missing",
    );
  signal?.throwIfAborted();
  return env;
}
