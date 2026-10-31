import { remoteReviewSnapshot } from "./review-snapshot";
import {
  readWorktreeProvenance,
  writeWorktreeProvenance,
  worktreeProvenancePath,
} from "./worktree-provenance";
import { discoveryFacts, selected } from "../../shared/agent-launch-values";
import { createHash, randomUUID } from "node:crypto";
import { remoteCheckout } from "./agent-discovery";
import { cpus, loadavg, totalmem, homedir } from "node:os";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LaunchFailure } from "../../shared/launch-failure";
import { bundledAgentData } from "../../shared/bundled-agent-data";
import { parseAgentManifest } from "../../shared/agent-plugin-parser";
import {
  HOST_CLONE_TIMEOUT_MS,
  HOST_NETWORK_GIT_TIMEOUT_MS,
  hostManagement,
} from "../../shared/registered-hosts";
import type {
  HostManagement,
  HostResult,
  HostFacts,
  RemoteWorktree,
} from "../../shared/registered-hosts.d";
import { hostDiscovery, hostProbe, hostLoginEnvironment } from "./agent-discovery";

/** Validate existing ancestors; only enrollment and explicit cloning may create them. */
export async function approvedCodeFolder(
  input: string,
  home: string,
  mode: "existing" | "create" = "existing",
): Promise<string> {
  const path = input.startsWith("~/") ? join(home, input.slice(2)) : input;
  if (resolve(path) !== path || path === "/") throw new Error("unsafe-folder");
  let current = "/";
  for (const part of path.slice(1).split("/")) {
    current = join(current, part);
    if (mode === "create") {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST")
          throw new Error("folder-refused", { cause: error });
      }
    }
    const info = await lstat(current);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      ((info.mode & 0o022) !== 0 &&
        !(current !== path && info.uid === 0 && (info.mode & 0o1000) !== 0)) ||
      (current === path && info.uid !== process.getuid?.())
    )
      throw new Error("unsafe-folder");
  }
  if ((await realpath(path)) !== path) throw new Error("unsafe-folder");
  return path;
}
/** Linux MemAvailable includes reclaimable cache; macOS available = free + inactive + speculative pages (vm_stat), excluding wired/compressed pages. */
export async function availableMemory(
  platform: string,
  home: string,
  signal?: AbortSignal,
): Promise<number> {
  if (platform === "linux") {
    const text = await readFile("/proc/meminfo", "utf8");
    const match = /^MemAvailable:\s+(\d+) kB$/mu.exec(text);
    if (!match?.[1]) throw new Error("Memory unavailable");
    return Number(match[1]) * 1024;
  }
  const text = await hostProbe("/usr/bin/vm_stat", [], home, undefined, false, 5000, signal);
  const page = /page size of (\d+) bytes/u.exec(text)?.[1];
  if (!page) throw new Error("Memory unavailable");
  let count = 0;
  for (const name of ["free", "inactive", "speculative"]) {
    const match = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, "mu").exec(text)?.[1];
    if (!match) throw new Error("Memory unavailable");
    count += Number(match);
  }
  return count * Number(page);
}
export async function manageHost(
  request: HostManagement,
  sessions: number,
  shell: string,
  version: string,
  home = homedir(),
  signal?: AbortSignal,
): Promise<HostResult> {
  signal?.throwIfAborted();
  if (!hostManagement(request)) return { ok: false, reason: "folder-refused" };
  let folder: string;
  try {
    folder = await approvedCodeFolder(
      request.codeFolder,
      home,
      request.operation === "inspect" || request.operation === "clone" ? "create" : "existing",
    );
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && error.message === "unsafe-folder"
          ? "unsafe-folder"
          : "folder-refused",
    };
  }
  let facts: HostFacts;
  try {
    const agents: HostFacts["agents"][number][] = [];
    for (const model of (request.operation === "inspect" ? request.agents : []) ??
      bundledAgentData.map((data) => parseAgentManifest(JSON.stringify(data), "bundled").model)) {
      try {
        signal?.throwIfAborted();
        const found = await hostDiscovery(model, shell, home, signal);
        const bundled = bundledAgentData
          .map((data) => parseAgentManifest(JSON.stringify(data), "bundled").model)
          .find((entry) => entry.id === model.id);
        const facts =
          bundled &&
          discoveryFacts(bundled, found.version, found.help, {
            control: true,
            hooksEnabled: true,
            hasPrompt: true,
            configGreeting: false,
            resume: false,
            healthTrusted: false,
            setupState: "unavailable",
          });
        const attachment =
          bundled?.launch.extension ??
          (bundled?.hooks?.channels.some((channel) => channel.observer.transport === "event-module")
            ? bundled.launch.mcp
            : undefined);
        agents.push({
          id: model.id,
          state:
            found.version &&
            found.help &&
            bundled &&
            (!attachment ||
              (facts &&
                selected(attachment.when, facts) &&
                (!bundled.launch.prompt?.requires ||
                  facts[bundled.launch.prompt.requires] === true)))
              ? "ready"
              : "unable",
        });
      } catch (error) {
        agents.push({
          id: model.id,
          state:
            error instanceof LaunchFailure && error.reason === "remote_agent_unavailable"
              ? "missing"
              : "unable",
        });
      }
    }
    facts = {
      codeFolder: folder,
      version,
      sessions,
      cores: cpus().length,
      load: loadavg(),
      memoryTotal: totalmem(),
      memoryAvailable: Math.min(totalmem(), await availableMemory(process.platform, home, signal)),
      agents,
    };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  signal?.throwIfAborted();
  if (request.operation === "inspect") return { ok: true, facts };

  const env = {
    ...(await hostLoginEnvironment(shell, home, signal)),
    GIT_TERMINAL_PROMPT: "0",
    // Management safety decisions must use stored history, never local overlays.
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null",
  };
  const git = (args: string[], cwd: string, timeout = 5000) =>
    hostProbe("git", ["--no-optional-locks", ...args], cwd, env, true, timeout, signal);
  const checkout = async (directory: string, origin: string) => {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0 ||
      (await realpath(directory)) !== directory ||
      (await git(["config", "--get", "remote.origin.url"], directory)).trim() !== origin ||
      (await git(["rev-parse", "--show-toplevel"], directory)).trim() !== directory
    )
      throw new Error("Invalid checkout");
    // An initialized repository left by an interrupted clone is not a checkout.
    await git(["rev-parse", "--verify", "HEAD^{commit}"], directory);
    return await git(["status", "--porcelain", "-z", "--untracked-files=normal"], directory);
  };
  try {
    // Revalidate without recreating a folder removed since the initial check.
    signal?.throwIfAborted();
    await approvedCodeFolder(folder, home);
    if (request.operation === "list-worktrees") {
      const entries = await opendir(folder);
      let count = 0;
      const own: RemoteWorktree[] = [];
      let other = 0;
      for await (const entry of entries) {
        if (++count > 4096) throw new Error("Inventory too large");
        signal?.throwIfAborted();
        if (!entry.name.startsWith(".foom-worktree-") || !entry.isDirectory()) continue;
        const destination = join(folder, entry.name);
        const owner = await readWorktreeProvenance(destination);
        if (!owner || owner.profile !== request.profile) {
          other++;
          continue;
        }
        const directory = `repository-${createHash("sha256").update(owner.origin).digest("hex").slice(0, 24)}`;
        if (owner.repository !== join(folder, directory)) continue;
        try {
          await checkout(owner.repository, owner.origin);
          await checkout(destination, owner.origin);
          const identity = createHash("sha256")
            .update(await remoteCheckout(owner.repository, destination, env, signal))
            .digest("hex");
          const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], destination)
            .then((value) => value.trim())
            .catch(() => "HEAD");
          if (branch !== "HEAD") await git(["check-ref-format", "--branch", branch], destination);
          const currentOwner = await readWorktreeProvenance(destination);
          if (
            !currentOwner ||
            currentOwner.profile !== owner.profile ||
            currentOwner.repository !== owner.repository ||
            currentOwner.origin !== owner.origin
          )
            continue;
          if (own.length >= 128) return { ok: false, reason: "checkout-refused" };
          own.push({
            repository: owner.repository,
            path: destination,
            branch,
            identity,
            origin: owner.origin,
          });
        } catch {
          /* Invalid/stale owned entries do not become launch targets. */
        }
      }
      await approvedCodeFolder(folder, home);
      return { ok: true, facts, inventory: { own, other } };
    }
    const path = join(folder, request.directory);
    let exists = true;
    try {
      await lstat(path);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      exists = false;
    }
    if (!exists && request.operation !== "clone")
      return { ok: true, facts, checkout: { path, state: "absent" } };
    let status: string;
    if (!exists) {
      const temporary = await mkdtemp(join(folder, ".foom-clone-"));
      try {
        await hostProbe(
          "git",
          ["--no-optional-locks", "clone", "--", request.origin, temporary],
          folder,
          env,
          true,
          HOST_CLONE_TIMEOUT_MS,
          signal,
        );
        status = await checkout(temporary, request.origin);
        signal?.throwIfAborted();
        await approvedCodeFolder(folder, home);
        // Do not replace a destination that appeared while cloning.
        try {
          await lstat(path);
          return { ok: false, reason: "checkout-refused" };
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
            throw error;
        }
        signal?.throwIfAborted();
        await rename(temporary, path);
      } catch {
        return { ok: false, reason: "clone-failed" };
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    } else status = await checkout(path, request.origin);
    if (request.operation === "create-worktree") {
      await git(["check-ref-format", "--branch", request.branch], path);
      const refs = await git(
        ["for-each-ref", "--format=%(refname)", `refs/heads/${request.branch}`],
        path,
      );
      if (refs.trim()) throw new Error("Branch exists");
      const remote = await git(
        ["ls-remote", "--symref", "origin", "HEAD"],
        path,
        HOST_NETWORK_GIT_TIMEOUT_MS,
      );
      const base = /^ref: refs\/heads\/(\S+)\s+HEAD$/mu.exec(remote)?.[1];
      if (!base || base.startsWith("-")) throw new Error("Default unavailable");
      await git(["check-ref-format", "--branch", base], path);
      if (request.fromOrigin && request.branch === base) throw new Error("Default branch");
      const source = request.fromOrigin ? request.branch : base;
      await git(
        ["fetch", "--no-tags", "origin", `+refs/heads/${source}:refs/remotes/origin/${source}`],
        path,
        HOST_NETWORK_GIT_TIMEOUT_MS,
      );
      const destination = join(folder, `.foom-worktree-${randomUUID()}`);
      signal?.throwIfAborted();
      await approvedCodeFolder(folder, home);
      await mkdir(destination, { mode: 0o700 });
      // Persist ownership before Git can publish a checkout, including after disconnect.
      await writeWorktreeProvenance(request.profile, path, destination, request.origin);
      signal?.throwIfAborted();
      await approvedCodeFolder(folder, home);
      await git(
        [
          "worktree",
          "add",
          request.fromOrigin ? "--track" : "--no-track",
          "-b",
          request.branch,
          "--",
          destination,
          `refs/remotes/origin/${source}`,
        ],
        path,
      );
      if (request.fromOrigin)
        await git(["config", `branch.${request.branch}.pushRemote`, "origin"], path);
      const identity = createHash("sha256")
        .update(await remoteCheckout(path, destination, env, signal))
        .digest("hex");
      return {
        ok: true,
        facts,
        worktree: { path: destination, branch: request.branch, identity, changes: "" },
      };
    }
    if (
      request.operation === "inspect-worktree" ||
      request.operation === "snapshot-worktree" ||
      request.operation === "remove-worktree"
    ) {
      if (
        request.path === path ||
        !request.path.startsWith(`${folder}/.foom-worktree-`) ||
        request.path.slice(folder.length + 1).includes("/")
      )
        throw new Error("Outside approved folder");
      const owner = await readWorktreeProvenance(request.path);
      if (
        !owner ||
        owner.profile !== request.profile ||
        owner.repository !== path ||
        owner.origin !== request.origin
      )
        throw new Error("Foreign worktree");
      const identity = createHash("sha256")
        .update(await remoteCheckout(path, request.path, env, signal))
        .digest("hex");
      if (identity !== request.identity) throw new Error("Identity changed");
      const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], request.path)
        .then((value) => value.trim())
        .catch(async () => {
          if (
            (await git(["rev-parse", "--symbolic-full-name", "HEAD"], request.path)).trim() !==
            "HEAD"
          )
            throw new Error("Branch unavailable");
          return "HEAD";
        });
      if (branch !== "HEAD") await git(["check-ref-format", "--branch", branch], path);
      const changes = await git(["status", "--porcelain", "--untracked-files=all"], request.path);
      if (changes.length > 65536) throw new Error("Changes too large");
      if (request.operation === "remove-worktree") {
        if (request.changes !== changes) throw new Error("Changes changed");
        signal?.throwIfAborted();
        await approvedCodeFolder(folder, home);
        if (
          createHash("sha256")
            .update(await remoteCheckout(path, request.path, env, signal))
            .digest("hex") !== identity
        )
          throw new Error("Identity changed");
        if (branch === "HEAD") {
          const head = (await git(["rev-parse", "--verify", "HEAD^{commit}"], request.path)).trim();
          if (
            !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(head) ||
            !(
              await git(
                [
                  "-c",
                  "core.commitGraph=false",
                  "for-each-ref",
                  "--format=%(refname)",
                  `--contains=${head}`,
                  "refs/heads",
                  "refs/remotes",
                  "refs/tags",
                ],
                request.path,
              )
            ).trim()
          )
            throw new Error("Unreachable detached HEAD");
          if ((await git(["rev-parse", "--verify", "HEAD^{commit}"], request.path)).trim() !== head)
            throw new Error("HEAD changed");
        }
        const owner = await readWorktreeProvenance(request.path);
        if (
          !owner ||
          owner.profile !== request.profile ||
          owner.repository !== path ||
          owner.origin !== request.origin
        )
          throw new Error("Ownership changed");
        await git(["worktree", "remove", "--force", "--", request.path], path);
        await rm(worktreeProvenancePath(request.path));
      }
      if (request.operation === "remove-worktree")
        return { ok: true, facts, worktree: { path: request.path, branch, identity, changes } };
      const head = (await git(["rev-parse", "--verify", "HEAD^{commit}"], request.path)).trim();
      const origin = (await git(["config", "--get", "remote.origin.url"], request.path)).trim();
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(head) || origin !== request.origin)
        throw new Error("Checkout changed");
      const snapshot =
        request.operation === "snapshot-worktree"
          ? await remoteReviewSnapshot(path, request.path, identity, env, signal)
          : undefined;
      await approvedCodeFolder(folder, home);
      if (
        createHash("sha256")
          .update(await remoteCheckout(path, request.path, env, signal))
          .digest("hex") !== identity ||
        (await git(["config", "--get", "remote.origin.url"], request.path)).trim() !== origin ||
        (snapshot && snapshot.head !== head)
      )
        throw new Error("Checkout changed");
      return {
        ok: true,
        facts,
        worktree: {
          path: request.path,
          branch,
          identity,
          changes,
          head,
          origin,
          ...(snapshot ? { snapshot } : {}),
        },
      };
    }
    return { ok: true, facts, checkout: { path, state: status ? "changed" : "clean" } };
  } catch {
    return { ok: false, reason: "checkout-refused" };
  }
}
