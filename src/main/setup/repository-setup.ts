import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { readOwnedFile } from "../../node-common/owned-files";
import { atomicPrivate, privateDirectory, verifyPrivate } from "../../node-common/private-files";
import {
  setupCatalogDigest,
  setupDigest,
  setupCatalogV1Digest,
} from "../../node-common/repository-setup-digest";
import {
  parseSetupList,
  parseSetupListV1,
  parseSetupDraft,
  setupAction,
  setupSourcePath,
  setupSources,
} from "../../shared/repository-setup";
import { setupPlan } from "../../shared/repository-setup-catalog";
import type {
  RepositorySetupList,
  RepositorySetupState,
  SetupApproval,
  SetupCheck,
  SetupReview,
  SetupRow,
  SetupSources,
} from "../../shared/repository-setup.d";
import type { DialogContent } from "../../shared/confirmation";
import { LaunchFailure } from "../../shared/launch-failure";

export interface RepositorySetupDependencies {
  beforeApprove?: () => Promise<void>;
  repositories: () => readonly { path: string }[];
  identity: (repository: string) => string;
  hosts: () => readonly { host: string; codeFolder: string }[];
  sources: (
    repository: string,
    checkout: string | undefined,
    paths: readonly string[],
    host: string | null,
  ) => Promise<
    { sources?: SetupSources; head: string; checkout: string; root?: string } | undefined
  >;
  check: (
    host: string | null,
    list: RepositorySetupList,
    checkout?: string,
    repository?: string,
  ) => Promise<SetupCheck>;
  bins?: (list: RepositorySetupList) => Promise<string[]>;
  save: (approvals: readonly SetupApproval[], rows: readonly SetupRow[]) => Promise<void>;
}

interface ReviewToken {
  scope: string;
  review: SetupReview;
  approval: SetupApproval;
}
interface RunToken {
  scope: string;
  row: SetupRow;
  binding: string;
  plan: string;
}
const token = () => randomBytes(16).toString("hex");
const key = (host: string | null, repository: string) => JSON.stringify([host, repository]);
const evidencePaths = (list: RepositorySetupList) =>
  [...new Set([...list.evidence, ...list.requirements.flatMap((item) => item.sources)])].sort();
function changedSources(previous: SetupSources | undefined, current: SetupSources): string[] {
  return [
    ...new Set([
      ...(previous?.files.map((file) => file.path) ?? []),
      ...current.files.map((file) => file.path),
    ]),
  ]
    .filter(
      (path) =>
        previous?.files.find((file) => file.path === path)?.digest !==
        current.files.find((file) => file.path === path)?.digest,
    )
    .sort();
}
/** App-wide main owner. Tokens are scoped to the requesting board, never control tools. */
export class RepositorySetup {
  private approvals: readonly SetupApproval[];
  private readonly rows = new Map<string, SetupRow>();
  private readonly reviews = new Map<string, ReviewToken>();
  private readonly scopeRevisions = new Map<string, number>();
  private readonly unresolvedOrigins = new Map<string, { repository: string; ids: Set<string> }>();
  private readonly plans = new Map<string, RunToken>();
  private pending: Promise<unknown> = Promise.resolve();
  private readonly running = new Map<string | null, { repository: string; cancel(): void }>();
  private readonly hostGenerations = new Map<string, number>();
  constructor(
    private readonly deps: RepositorySetupDependencies,
    approvals: readonly SetupApproval[] = [],
    rows: readonly SetupRow[] = [],
  ) {
    this.approvals = approvals;
    for (const row of rows)
      this.rows.set(key(row.host, row.repository), {
        ...row,
        plan: undefined,
        token: undefined,
        running: undefined,
      });
  }
  static async open(
    profile: string,
    deps: Omit<RepositorySetupDependencies, "save">,
  ): Promise<RepositorySetup> {
    const directory = join(await realpath(profile), "repository-setup");
    let storageReady = false;
    let approvals: SetupApproval[] = [];
    const savedRows: SetupRow[] = [];
    try {
      await verifyPrivate(directory, true);
      storageReady = true;
      const value: unknown = JSON.parse(
        await readOwnedFile(join(directory, "state.json"), 16 * 1024 * 1024),
      );
      if (
        !value ||
        typeof value !== "object" ||
        !("approvals" in value) ||
        !Array.isArray(value.approvals) ||
        value.approvals.length > 256
      )
        throw new Error("Invalid setup state");
      if ("rows" in value && Array.isArray(value.rows) && value.rows.length <= 4096) {
        for (const raw of value.rows) {
          const row: unknown = raw;
          if (
            !row ||
            typeof row !== "object" ||
            !("repository" in row) ||
            typeof row.repository !== "string" ||
            !("host" in row) ||
            (row.host !== null && typeof row.host !== "string") ||
            !("state" in row) ||
            !("revision" in row) ||
            typeof row.revision !== "number" ||
            !Number.isSafeInteger(row.revision) ||
            row.revision < 0 ||
            !("missing" in row) ||
            !Array.isArray(row.missing) ||
            row.missing.length > 128 ||
            !row.missing.every(
              (id: unknown) => typeof id === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(id),
            ) ||
            !("changed" in row) ||
            !Array.isArray(row.changed) ||
            row.changed.length > 64 ||
            !row.changed.every(setupSourcePath) ||
            !("sourcesAtLaunch" in row) ||
            typeof row.sourcesAtLaunch !== "boolean"
          )
            continue;
          const state = row.state;
          if (
            state !== "no-list" &&
            state !== "not-checked" &&
            state !== "met" &&
            state !== "needs-setup" &&
            state !== "review-needed" &&
            state !== "unable" &&
            state !== "manual"
          )
            continue;
          const missing = row.missing.filter((id: unknown): id is string => typeof id === "string");
          const changed = row.changed.filter(setupSourcePath);
          savedRows.push({
            repository: row.repository,
            host: row.host,
            revision: row.revision,
            state,
            missing,
            changed,
            sourcesAtLaunch: row.sourcesAtLaunch,
            ...("checkedAt" in row &&
            typeof row.checkedAt === "number" &&
            Number.isSafeInteger(row.checkedAt) &&
            row.checkedAt > 0
              ? { checkedAt: row.checkedAt }
              : {}),
          });
        }
      }
      approvals = value.approvals.map((entry: unknown) => {
        if (
          !entry ||
          typeof entry !== "object" ||
          !("repository" in entry) ||
          !("identity" in entry) ||
          !("revision" in entry) ||
          !("digest" in entry) ||
          !("catalog" in entry) ||
          !("sources" in entry) ||
          !("checkout" in entry) ||
          !("head" in entry) ||
          !("approvedAt" in entry) ||
          !("list" in entry) ||
          typeof entry.repository !== "string" ||
          typeof entry.identity !== "string" ||
          typeof entry.revision !== "number" ||
          !Number.isSafeInteger(entry.revision) ||
          entry.revision < 1 ||
          typeof entry.catalog !== "string" ||
          !/^[a-f0-9]{64}$/u.test(entry.catalog) ||
          typeof entry.checkout !== "string" ||
          typeof entry.head !== "string" ||
          typeof entry.approvedAt !== "number" ||
          !Number.isSafeInteger(entry.approvedAt)
        )
          throw new Error("Invalid setup approval");
        const list = (entry.catalog === setupCatalogV1Digest ? parseSetupListV1 : parseSetupList)(
          JSON.stringify(entry.list),
        );
        if (entry.digest !== setupDigest(list)) throw new Error("Invalid setup digest");
        const sources = entry.sources;
        if (!setupSources(sources)) throw new Error("Invalid setup sources");
        const files = sources.files.map((file: { path: string; digest: string }) => ({
          path: file.path,
          digest: file.digest,
        }));
        if (sources.fingerprint !== setupDigest(files)) throw new Error("Invalid source digest");
        return {
          repository: entry.repository,
          identity: entry.identity,
          revision: entry.revision,
          digest: entry.digest,
          catalog: entry.catalog,
          sources: { fingerprint: sources.fingerprint, files },
          checkout: entry.checkout,
          head: entry.head,
          approvedAt: entry.approvedAt,
          list,
        };
      });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        throw new Error("Unable to read repository setup approvals", { cause: error });
    }
    return new RepositorySetup(
      {
        ...deps,
        save: async (approvals, rows) => {
          if (!storageReady) {
            await privateDirectory(profile, "repository-setup");
            storageReady = true;
          }
          await atomicPrivate(directory, "state.json", { version: 1, approvals, rows });
        },
      },
      approvals,
      savedRows,
    );
  }
  private stored(repository: string): SetupApproval | undefined {
    return this.approvals.find((entry) => entry.repository === repository);
  }
  private active(repository: string): SetupApproval | undefined {
    const identity = this.deps.identity(repository);
    return this.approvals.find(
      (entry) => entry.repository === repository && entry.identity === identity,
    );
  }
  private registration(host: string | null, repository: string): string {
    const identity = this.deps.identity(repository);
    if (host === null) return JSON.stringify([identity, null]);
    const registration = this.deps.hosts().find((entry) => entry.host === host);
    if (!registration) throw new Error("Host is not registered");
    return JSON.stringify([
      identity,
      registration.host,
      registration.codeFolder,
      this.hostGenerations.get(host) ?? 0,
    ]);
  }
  private binding(host: string | null, repository: string): string {
    const active = this.active(repository);
    return setupDigest([
      this.registration(host, repository),
      active?.revision,
      active?.digest,
      active?.catalog,
      active?.sources.fingerprint,
      setupCatalogDigest,
    ]);
  }
  state(scope: string): RepositorySetupState {
    return {
      rows: this.deps.repositories().flatMap((repo) =>
        [null, ...this.deps.hosts().map((host) => host.host)].map((host): SetupRow => {
          const active = this.active(repo.path);
          const saved = this.rows.get(key(host, repo.path));
          const row: SetupRow = !active
            ? {
                host,
                repository: repo.path,
                revision: 0,
                state: this.stored(repo.path) ? "review-needed" : "no-list",
                missing: [],
                changed: [],
                sourcesAtLaunch: false,
              }
            : active.catalog !== setupCatalogDigest
              ? {
                  host,
                  repository: repo.path,
                  revision: active.revision,
                  state: "review-needed",
                  missing: [],
                  changed: [],
                  sourcesAtLaunch: false,
                }
              : saved?.revision === active.revision
                ? saved
                : {
                    host,
                    repository: repo.path,
                    revision: active.revision,
                    state: "not-checked",
                    missing: [],
                    changed: [],
                    sourcesAtLaunch: host !== null,
                  };
          const plan = [...this.plans].find(
            ([, value]) =>
              value.scope === scope &&
              value.row.host === host &&
              value.row.repository === repo.path &&
              value.binding === this.binding(host, repo.path) &&
              row.state === "needs-setup" &&
              !row.failure &&
              row.plan &&
              value.plan === setupDigest(row.plan),
          );
          return {
            ...row,
            noRequirements: active?.list.requirements.length === 0,
            ...(plan ? { token: plan[0] } : {}),
            ...(this.running.get(host)?.repository === repo.path
              ? { running: "Setup already running" }
              : {}),
          };
        }),
      ),
    };
  }
  cancelScope(scope: string, keepDraft = false): void {
    this.scopeRevisions.set(scope, (this.scopeRevisions.get(scope) ?? 0) + 1);
    if (!keepDraft) this.unresolvedOrigins.delete(scope);
    for (const [id, entry] of this.reviews) if (entry.scope === scope) this.reviews.delete(id);
    for (const [id, entry] of this.plans) if (entry.scope === scope) this.plans.delete(id);
  }
  private invalidate(repository: string): void {
    for (const [id, entry] of this.reviews)
      if (entry.review.repository === repository) this.reviews.delete(id);
    for (const [id, entry] of this.plans)
      if (entry.row.repository === repository) this.plans.delete(id);
    for (const [id, row] of this.rows) if (row.repository === repository) this.rows.delete(id);
    for (const entry of this.running.values()) if (entry.repository === repository) entry.cancel();
  }
  async forgetRepository(repository: string): Promise<void> {
    this.invalidate(repository);
    await this.queue(async () => {
      const approvals = this.approvals.filter((entry) => entry.repository !== repository);
      await this.persist(approvals);
      this.approvals = approvals;
    });
  }
  async forgetHost(host: string): Promise<void> {
    this.hostGenerations.set(host, (this.hostGenerations.get(host) ?? 0) + 1);
    for (const [id, row] of this.rows) if (row.host === host) this.rows.delete(id);
    for (const [id, entry] of this.plans) if (entry.row.host === host) this.plans.delete(id);
    await this.persist();
  }
  private persist(approvals = this.approvals): Promise<void> {
    return this.deps.save(
      approvals.filter((entry) =>
        this.deps.repositories().some((repo) => repo.path === entry.repository),
      ),
      [...this.rows.values()]
        .filter(
          (row) =>
            this.deps.repositories().some((repo) => repo.path === row.repository) &&
            (row.host === null || this.deps.hosts().some((host) => host.host === row.host)),
        )
        .map((row) => ({
          ...row,
          plan: undefined,
          token: undefined,
          running: undefined,
        })),
    );
  }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.pending.catch(() => undefined).then(work);
    this.pending = pending;
    return pending;
  }
  async action(
    scope: string,
    input: unknown,
    confirm: (content: DialogContent) => Promise<boolean>,
    launch: (
      host: string | null,
      approval: SetupApproval,
      row: SetupRow,
      finished: () => void,
      signal: AbortSignal,
      validate: () => Promise<void>,
    ) => Promise<string>,
    signal: AbortSignal,
  ): Promise<RepositorySetupState> {
    if (!setupAction(input)) throw new Error("Invalid repository setup action");
    if (input.action === "list" || input.action === "copy-brief") return this.state(scope);
    if (input.action === "cancel-review") {
      this.cancelScope(scope, input.keepDraft);
      return this.state(scope);
    }
    if (input.action === "check") {
      await this.check(scope, input.host, input.repository);
      return this.state(scope);
    }
    if (input.action === "review") {
      const generation = this.scopeRevisions.get(scope) ?? 0;
      const identity = this.deps.identity(input.repository);
      const active = this.active(input.repository);
      const draft =
        input.draft === undefined
          ? {
              list: active?.list ??
                this.stored(input.repository)?.list ?? { requirements: [], evidence: [] },
              unresolved: [],
            }
          : parseSetupDraft(input.draft);
      const list = draft.list;
      const previousOrigin = this.unresolvedOrigins.get(scope);
      const origin =
        previousOrigin?.repository === input.repository
          ? previousOrigin
          : { repository: input.repository, ids: new Set<string>() };
      for (const item of draft.unresolved) origin.ids.add(item.id);
      if (origin.ids.size > 128) throw new Error("Too many unresolved draft requirements");
      this.unresolvedOrigins.set(scope, origin);
      const observed = await this.deps.sources(
        input.repository,
        input.repository,
        evidencePaths(list),
        null,
      );
      signal.throwIfAborted();
      if (
        !observed?.sources ||
        (this.scopeRevisions.get(scope) ?? 0) !== generation ||
        this.deps.identity(input.repository) !== identity ||
        this.active(input.repository)?.revision !== active?.revision
      )
        throw new Error("Sources or approval changed; review again");
      const id = token();
      const review: SetupReview = {
        token: id,
        repository: input.repository,
        revision: active?.revision ?? 0,
        list,
        ...(active ? { previous: active.list } : {}),
        catalog: setupCatalogDigest,
        sources: observed.sources,
        changed: changedSources(active?.sources, observed.sources),
        unresolved: draft.unresolved,
        removed: [...origin.ids].filter(
          (id) => ![...list.requirements, ...draft.unresolved].some((item) => item.id === id),
        ),
      };
      this.cancelScope(scope, true);
      this.reviews.set(id, {
        scope,
        review,
        approval: {
          repository: input.repository,
          identity,
          revision: review.revision + 1,
          digest: setupDigest(list),
          catalog: setupCatalogDigest,
          sources: observed.sources,
          checkout: observed.checkout,
          head: observed.head,
          approvedAt: Date.now(),
          list,
        },
      });
      return { ...this.state(scope), review };
    }
    if (input.action === "approve")
      return this.queue(async () => {
        const entry = this.reviews.get(input.token);
        if (!entry || entry.scope !== scope) throw new Error("Review expired");
        if (entry.review.unresolved?.length)
          throw new Error("Resolve or explicitly remove unsupported requirements before approval");
        const approval = entry.approval;
        // Historical lists are display/edit data only, never executable approval.
        parseSetupList(JSON.stringify(approval.list));
        if (
          !(await confirm({
            title: entry.review.revision
              ? "Replace repository setup list?"
              : "Approve repository setup list?",
            accept: "Approve list",
            subject: approval.repository,
            detail: approval.list.requirements.length
              ? "Save this profile-only list as the repository launch prerequisite. A later Set up click can install these packages/toolchains, including sudo steps. Approval installs nothing."
              : "Save an empty list and remove all repository launch prerequisites. Installed packages and toolchains are kept. Approval installs nothing.",
            sections: approval.list.requirements.map((item) => ({
              label: `${item.id} · ${item.purpose}`,
              items:
                item.kind === "toolchain"
                  ? [`${item.tool} ${item.version}`]
                  : Object.entries(item.packages).map(
                      ([distro, names]) =>
                        `${distro}: ${names === "unsupported" ? "Unsupported" : names.join(", ") || "No packages"}`,
                    ),
            })),
            facts: [
              { label: "Revision", value: String(approval.revision) },
              { label: "List digest", value: approval.digest },
            ],
          }))
        )
          return { ...this.state(scope), review: entry.review };
        signal.throwIfAborted();
        await this.deps.beforeApprove?.();
        const observed = await this.deps.sources(
          approval.repository,
          approval.checkout,
          evidencePaths(approval.list),
          null,
        );
        signal.throwIfAborted();
        if (
          this.reviews.get(input.token) !== entry ||
          this.deps.identity(approval.repository) !== approval.identity ||
          (this.active(approval.repository)?.revision ?? 0) !== entry.review.revision ||
          !observed?.sources ||
          observed.sources.fingerprint !== approval.sources.fingerprint ||
          approval.catalog !== setupCatalogDigest
        )
          throw new Error("Sources or approval changed; review again");
        const approvals = [
          ...this.approvals.filter((item) => item.repository !== approval.repository),
          { ...approval, approvedAt: Date.now() },
        ];
        await this.persist(approvals);
        this.approvals = approvals;
        this.unresolvedOrigins.delete(scope);
        this.invalidate(approval.repository);
        return this.state(scope);
      });
    if (input.action === "remove") {
      const active = this.active(input.repository);
      const stored = active ?? this.stored(input.repository);
      if (!stored) return this.state(scope);
      if (
        !(await confirm({
          title: "Remove setup list?",
          accept: "Remove setup list",
          subject: input.repository,
          detail:
            "Removes this repository’s launch prerequisite. Installed packages and toolchains are kept.",
        }))
      )
        return this.state(scope);
      return this.queue(async () => {
        signal.throwIfAborted();
        if (this.active(input.repository) !== active) throw new Error("Approval changed");
        const approvals = this.approvals.filter((entry) => entry !== stored);
        await this.persist(approvals);
        this.approvals = approvals;
        this.invalidate(input.repository);
        return this.state(scope);
      });
    }
    const entry = this.plans.get(input.token);
    if (!entry || entry.scope !== scope) throw new Error("Setup plan expired; recheck this row");
    const { row } = entry;
    const active = this.active(row.repository);
    if (
      !active ||
      this.running.has(row.host) ||
      !row.plan ||
      entry.binding !== this.binding(row.host, row.repository)
    )
      throw new Error("Setup already running or changed");
    this.plans.delete(input.token);
    const cancellation = new AbortController();
    this.running.set(row.host, {
      repository: row.repository,
      cancel: () => {
        cancellation.abort();
      },
    });
    try {
      const refreshed = await this.observe(row.host, row.repository);
      signal.throwIfAborted();
      cancellation.signal.throwIfAborted();
      if (
        entry.binding !== this.binding(row.host, row.repository) ||
        refreshed.state !== "needs-setup" ||
        setupDigest(refreshed.plan) !== setupDigest(row.plan) ||
        setupDigest(refreshed.location ?? null) !== setupDigest(row.location ?? null)
      )
        throw new Error("Setup plan changed; review the row again");
      const recipeSession = await launch(
        row.host,
        active,
        row,
        () => {
          this.running.delete(row.host);
          void this.check(scope, row.host, row.repository).catch(() => undefined);
        },
        cancellation.signal,
        async () => {
          cancellation.signal.throwIfAborted();
          signal.throwIfAborted();
          if (entry.binding !== this.binding(row.host, row.repository) || !row.location)
            throw new Error("Setup changed before dispatch");
          const current = await this.deps.sources(
            row.repository,
            row.location.present ? row.location.path : undefined,
            evidencePaths(active.list),
            row.host,
          );
          cancellation.signal.throwIfAborted();
          signal.throwIfAborted();
          if (
            !current ||
            entry.binding !== this.binding(row.host, row.repository) ||
            setupDigest({
              root: current.root ?? current.checkout,
              path: current.checkout,
              present: !!current.sources,
            }) !== setupDigest(row.location) ||
            (row.location.present && current.sources?.fingerprint !== active.sources.fingerprint)
          )
            throw new Error("Repository sources changed before dispatch");
        },
      );
      return { ...this.state(scope), recipeSession };
    } catch (error) {
      this.running.delete(row.host);
      throw error;
    }
  }
  private async observe(
    host: string | null,
    repository: string,
    checkout?: string,
  ): Promise<SetupRow> {
    const binding = this.binding(host, repository);
    const active = this.active(repository);
    if (!active)
      return {
        host,
        repository,
        revision: 0,
        state: "no-list",
        missing: [],
        changed: [],
        sourcesAtLaunch: false,
      };
    const base = {
      host,
      repository,
      revision: active.revision,
      checkedAt: Date.now(),
      missing: [] as string[],
      changed: [] as string[],
      sourcesAtLaunch: false,
    };
    if (active.catalog !== setupCatalogDigest) return { ...base, state: "review-needed" };
    try {
      const observed = await this.deps.sources(
        repository,
        checkout,
        evidencePaths(active.list),
        host,
      );
      if (!observed) return { ...base, state: "unable" };
      const changed = observed.sources ? changedSources(active.sources, observed.sources) : [];
      if (changed.length) return { ...base, changed, state: "review-needed" };
      const checked = await this.deps.check(
        host,
        active.list,
        observed.sources ? observed.checkout : undefined,
        repository,
      );
      if (
        checked.items.length !== active.list.requirements.length ||
        active.list.requirements.some(
          (requirement) => checked.items.filter((item) => item.id === requirement.id).length !== 1,
        )
      )
        throw new Error("Incomplete repository setup check");
      if (this.binding(host, repository) !== binding) return { ...base, state: "review-needed" };
      const missing = checked.items
        .filter((item) => item.state === "missing")
        .map((item) => item.id);
      const plan = setupPlan(active.list, checked);
      const state = checked.items.some((item) => item.state === "unable")
        ? "unable"
        : checked.items.some((item) => item.state === "manual") || (!plan && missing.length)
          ? "manual"
          : missing.length
            ? "needs-setup"
            : "met";
      return {
        ...base,
        missing,
        sourcesAtLaunch: !observed.sources,
        location: {
          root: observed.root ?? observed.checkout,
          path: observed.checkout,
          present: !!observed.sources,
        },
        state,
        ...(plan ? { plan } : {}),
      };
    } catch {
      return { ...base, state: "unable", failure: "check-failed" };
    }
  }
  async check(scope: string, host: string | null, repository: string): Promise<SetupRow> {
    const binding = this.binding(host, repository);
    const previous = this.rows.get(key(host, repository));
    const row = await this.observe(host, repository);
    if (this.binding(host, repository) !== binding) throw new Error("Setup changed");
    if (row.state === "unable" && previous?.revision === row.revision)
      row.missing = previous.missing;
    this.rows.set(key(host, repository), row);
    try {
      await this.queue(() => this.persist());
    } catch {
      row.failure = "save-failed";
      row.state = "unable";
    }
    let retained = false;
    for (const [id, entry] of this.plans)
      if (entry.scope === scope && entry.row.host === host && entry.row.repository === repository) {
        if (
          row.state === "needs-setup" &&
          !row.failure &&
          row.plan &&
          entry.binding === binding &&
          setupDigest(row.plan) === entry.plan
        ) {
          entry.row = row;
          retained = true;
        } else this.plans.delete(id);
      }
    if (row.state === "needs-setup" && !row.failure && row.plan && !retained)
      this.plans.set(token(), { scope, row, binding, plan: setupDigest(row.plan) });
    return row;
  }
  /** Current facts and actual checkout evidence, with synchronous final revocation check. */
  async admit(
    host: string | null,
    repository: string,
    checkout: string,
  ): Promise<
    (
      | { approval?: undefined; paths: string[] }
      | { approval: SetupApproval; paths: string[]; codeRoot: string }
    ) & { validate(): void }
  > {
    const active = this.active(repository);
    const binding = this.binding(host, repository);
    if (!active && this.stored(repository))
      throw new LaunchFailure("repository_setup_changed", undefined, {
        repository,
        host,
        missing: [],
      });
    if (!active)
      return {
        paths: [],
        validate: () => {
          if (binding !== this.binding(host, repository))
            throw new LaunchFailure("repository_setup_changed");
        },
      };
    const row = await this.observe(host, repository, checkout);
    if (row.sourcesAtLaunch || row.state !== "met")
      throw new LaunchFailure(
        row.state === "needs-setup"
          ? "repository_setup_missing"
          : row.state === "review-needed"
            ? "repository_setup_changed"
            : row.state === "manual"
              ? "repository_setup_manual"
              : "repository_setup_unavailable",
        undefined,
        {
          repository,
          host,
          missing: active.list.requirements
            .filter((item) => row.missing.includes(item.id))
            .map((item) => ({
              id: item.id,
              ...(item.kind === "toolchain" ? { version: item.version } : {}),
            })),
        },
      );
    if (binding !== this.binding(host, repository))
      throw new LaunchFailure("repository_setup_changed");
    if (!row.location) throw new LaunchFailure("repository_setup_unavailable");
    return {
      codeRoot: row.location.root,
      approval: active,
      paths: host === null ? ((await this.deps.bins?.(active.list)) ?? []) : [],
      validate: () => {
        if (binding !== this.binding(host, repository))
          throw new LaunchFailure("repository_setup_changed");
      },
    };
  }
}
