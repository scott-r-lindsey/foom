import type { ForgeRemote } from "./forge.d";
import type {
  CheckConclusion,
  ForgeCheckResult,
  ForgeGuard,
  ForgeManifest,
  ForgePath,
} from "../../shared/forge-plugin";
import { forgeHost } from "../../shared/forge-manifest";
import { forgeBranch, forgeTitle, forgeWebUrl } from "./forge";

export function forgeValue(value: unknown, path: ForgePath): unknown {
  let result = value;
  for (const key of path) {
    if (
      typeof result !== "object" ||
      result === null ||
      !Object.hasOwn(result, key) ||
      ["__proto__", "constructor", "prototype"].includes(String(key))
    )
      return undefined;
    result = Reflect.get(result, key);
  }
  return result;
}
export function forgeProject(project: string, namespace: "pair" | "nested"): boolean {
  const parts = project.split("/");
  return (
    project.length <= 1024 &&
    parts.length >= 2 &&
    parts.length <= (namespace === "pair" ? 2 : 16) &&
    parts.every((part) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/u.test(part))
  );
}
/** Parse raw spelling before URL normalization could hide dot segments or credentials. */
export function forgeRemote(remote: string, namespace: "pair" | "nested"): ForgeRemote | undefined {
  const match =
    /^(?:(?:https:\/\/|ssh:\/\/git@)([A-Za-z0-9.-]+)\/|git@([A-Za-z0-9.-]+):)([A-Za-z0-9_./-]+?)\/?$/u.exec(
      remote,
    );
  const host = (match?.[1] ?? match?.[2])?.toLowerCase();
  const rawProject = match?.[3];
  if (!host || !rawProject || !forgeHost(host)) return undefined;
  const project = rawProject.replace(/\.git$/u, "");
  return forgeProject(project, namespace) ? { host, project } : undefined;
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
/** These are policy decisions in Foom, never a mapped sameRepository boolean. */
export function forgeOwnership(
  manifest: ForgeManifest,
  row: unknown,
  remote: ForgeRemote,
): boolean | undefined {
  const fields = manifest.mapping.projects;
  if (fields.mode === "owner-and-cross-flag") {
    const owner = forgeValue(row, fields.owner);
    const cross = forgeValue(row, fields.crossProject);
    if (
      typeof owner !== "string" ||
      !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/u.test(owner) ||
      typeof cross !== "boolean"
    )
      return undefined;
    const targetOwner = remote.project.split("/")[0] ?? "";
    return (
      !cross &&
      (manifest.remote.case === "exact"
        ? owner === targetOwner
        : owner.toLowerCase() === targetOwner.toLowerCase())
    );
  }
  const source = forgeValue(row, fields.source);
  const target = forgeValue(row, fields.target);
  const context = forgeValue(row, fields.context);
  if (!positive(source) || !positive(target) || !positive(context)) return undefined;
  return source === target && target === context;
}
export function forgeIdentity(manifest: ForgeManifest, row: unknown, remote: ForgeRemote) {
  const mapping = manifest.mapping;
  const number = forgeValue(row, mapping.number);
  const branch = forgeValue(row, mapping.branch);
  const rawState = forgeValue(row, mapping.state);
  const state =
    typeof rawState === "string" && Object.hasOwn(mapping.states, rawState)
      ? mapping.states[rawState]
      : undefined;
  const sameRepository = forgeOwnership(manifest, row, remote);
  if (
    !positive(number) ||
    !forgeBranch(branch) ||
    state === undefined ||
    sameRepository === undefined
  )
    return undefined;
  return { number, branch, state, sameRepository };
}
function guardsPass(
  value: unknown,
  guards: readonly ForgeGuard[],
  headSha: string,
  number: number,
): boolean {
  return guards.every((guard) => {
    const field = forgeValue(value, guard.path);
    if (guard.absent) return field === undefined;
    if (guard.binding) return field === (guard.binding === "headSha" ? headSha : number);
    return Array.isArray(field) && field.length === guard.length;
  });
}
/** Validate every included row before combining; unknown always prevents green. */
export function reduceForgeChecks(
  value: unknown,
  result: ForgeCheckResult,
  headSha: string,
  number: number,
): CheckConclusion {
  if (!guardsPass(value, result.guards, headSha, number)) return "unknown";
  if (result.nullAt && forgeValue(value, result.nullAt) === null) return "none";
  const rows = forgeValue(value, result.rows);
  if (result.pageComplete && forgeValue(value, result.pageComplete) !== false) return "unknown";
  let items: unknown[];
  if (result.shape === "object") {
    if (typeof rows !== "object" || rows === null || Array.isArray(rows)) return "unknown";
    items = [rows];
  } else {
    if (!Array.isArray(rows) || rows.length > result.limit) return "unknown";
    items = rows;
  }
  const conclusions: CheckConclusion[] = [];
  for (const row of items) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return "unknown";
    if (result.required) {
      const required = forgeValue(row, result.required);
      if (typeof required !== "boolean") return "unknown";
      if (!required) continue;
    }
    if (!guardsPass(row, result.rowGuards, headSha, number)) return "unknown";
    const variants = result.variants.filter(
      (variant) => !variant.when || forgeValue(row, variant.when.path) === variant.when.equals,
    );
    if (variants.length !== 1) return "unknown";
    const variant = variants[0];
    if (!variant) return "unknown";
    if (variant.status) {
      const status = forgeValue(row, variant.status);
      if (typeof status === "string" && variant.unfinished.includes(status)) {
        conclusions.push("pending");
        continue;
      }
      if (status !== variant.completed) return "unknown";
    }
    const raw = forgeValue(row, variant.value);
    const mapped =
      typeof raw === "string" && Object.hasOwn(variant.table, raw) ? variant.table[raw] : undefined;
    if (mapped === undefined || mapped === "unknown") return "unknown";
    conclusions.push(mapped);
  }
  if (conclusions.includes("failure")) return "failure";
  if (conclusions.includes("pending")) return "pending";
  return conclusions.includes("success") ? "success" : "none";
}

/** Optional fields never participate in identity or check reduction. */
export function forgeDisplay(manifest: ForgeManifest, row: unknown, remote: ForgeRemote) {
  const title = manifest.mapping.title
    ? forgeTitle(forgeValue(row, manifest.mapping.title))
    : undefined;
  const url = manifest.mapping.webUrl
    ? forgeWebUrl(forgeValue(row, manifest.mapping.webUrl), remote.host)
    : undefined;
  const projects = manifest.mapping.projects;
  const sourceName =
    projects.mode === "owner-and-cross-flag"
      ? forgeTitle(forgeValue(row, projects.sourceName))
      : undefined;
  return {
    ...(title === undefined ? {} : { title }),
    ...(url === undefined ? {} : { url }),
    ...(sourceName === undefined ? {} : { sourceName }),
  };
}
