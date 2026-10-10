import type { BranchInventory, CreateOutcome } from "../../shared/worktrees";

/** Offered only when a repository has no prefixes of its own. */
export const CONVENTIONAL_PREFIXES = [
  "feat/",
  "fix/",
  "chore/",
  "docs/",
  "refactor/",
  "test/",
  "ci/",
];

/** Branch names cannot contain spaces; the field turns them into `-` as you type. */
export function normalizeBranch(text: string): string {
  return text.replace(/ /gu, "-");
}

/**
 * The `git check-ref-format --branch` rule a name breaks, as a short sentence. A trailing
 * `/` is a bare prefix still being typed, not a mistake. Main validates again on create.
 */
export function refProblem(name: string): string | undefined {
  if (name.startsWith("-")) return "Can't start with -";
  if (name === "HEAD" || name === "@") return `Can't be ${name}`;
  if (name.includes("..")) return "Can't contain ..";
  if (/[\0-\x20\x7f~^:?*[\\]/u.test(name)) return "Can't contain ~ ^ : ? * [ or \\";
  if (name.includes("@{")) return "Can't contain @{";
  const parts = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  if (parts.some((part) => !part || part.startsWith(".")))
    return "Each part needs a name and can't start with .";
  if (parts.some((part) => part.endsWith(".lock"))) return "A part can't end with .lock";
  if (name.endsWith(".")) return "Can't end with .";
  return undefined;
}

function branchNames(data: BranchInventory): string[] {
  return [...new Set([...data.local.map((branch) => branch.name), ...data.remoteBranches])].filter(
    (name) => name !== data.head,
  );
}

/** The repository's own prefixes, most used first; conventional ones when it has none. */
export function branchPrefixes(data: BranchInventory): string[] {
  const counts = new Map<string, number>();
  for (const name of new Set([
    ...data.local.map((branch) => branch.name),
    ...data.remoteBranches,
  ])) {
    const prefix = /^[^/]+\//u.exec(name)?.[0];
    if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  // Sorting is stable, so equally used prefixes keep the order Git listed them in.
  const used = [...counts].sort((a, b) => b[1] - a[1]).map(([prefix]) => prefix);
  return used.length ? used : CONVENTIONAL_PREFIXES;
}

export interface Candidate {
  value: string;
  /** Starts with what is typed, so it completes in place; otherwise shown right-aligned. */
  inline: boolean;
}

/** Prefixes, then branches starting with the text, then branches containing it. */
export function branchCandidates(data: BranchInventory, text: string): Candidate[] {
  const branches = branchNames(data);
  const starts = [...(text.includes("/") ? [] : branchPrefixes(data)), ...branches].filter(
    (value) => value.startsWith(text) && value !== text,
  );
  const lower = text.toLowerCase();
  const inside = text
    ? branches.filter((value) => !value.startsWith(text) && value.toLowerCase().includes(lower))
    : [];
  return [
    ...[...new Set(starts)].map((value) => ({ value, inline: true })),
    ...inside.map((value) => ({ value, inline: false })),
  ];
}

export type FieldOutcome =
  | { kind: CreateOutcome; text: string }
  | { kind: "invalid"; text: string }
  | undefined;

function lastSegment(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

/** What Enter does with exactly this text; undefined when it does nothing. */
export function branchOutcome(data: BranchInventory, text: string): FieldOutcome {
  if (!text) return undefined;
  const problem = refProblem(text);
  if (problem) return { kind: "invalid", text: problem };
  if (text.endsWith("/")) return undefined;
  const local = data.local.find((branch) => branch.name === text);
  if (local)
    return local.worktree
      ? { kind: "open", text: `open in ${lastSegment(local.worktree)}` }
      : { kind: "existing", text: "existing" };
  if (data.remoteBranches.includes(text))
    return { kind: "origin", text: `from ${data.remote ?? "origin"}` };
  return { kind: "new", text: `new, from ${data.head ?? "HEAD"}` };
}

/** The status line while main works. */
export function pendingText(data: BranchInventory, kind: CreateOutcome): string {
  return kind === "new" ? `Creating from ${data.head ?? "HEAD"}…` : "Checking out…";
}
