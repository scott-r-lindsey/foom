import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { git } from "../../../helpers/git.js";
import { nativeDeadline } from "../../../helpers/native-test-policy";
import { createWorktreeFixture } from "./worktree-git-fixture";

vi.setConfig({ testTimeout: nativeDeadline(5000) });

it("waits for tracked callbacks and their late Git commands before deleting fixtures", async () => {
  const fixture = createWorktreeFixture();
  const { temporary, repo } = await fixture.create();
  const release = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const operation = fixture.usingFixture(async () => {
    entered.resolve(undefined);
    await release.promise;
    expect((await git(["branch", "--show-current"], { cwd: repo })).stdout.trim()).toBe("main");
    await writeFile(join(repo, "late.txt"), "settled");
  })();
  await entered.promise;
  const cleanup = fixture.cleanup();
  try {
    expect(await realpath(temporary)).toBe(temporary);
  } finally {
    release.resolve(undefined);
    await operation;
    await cleanup;
  }
  await expect(realpath(temporary)).rejects.toThrow();
});

it("keeps fresh factories independent and drains rejected callbacks before cleanup", async () => {
  const first = createWorktreeFixture();
  const second = createWorktreeFixture();
  const a = await first.create();
  const b = await second.create();
  try {
    expect(a.repo).toContain("repo with spaces");
    expect(a.temporary).not.toBe(b.temporary);
    await writeFile(join(b.repo, "keep.txt"), "independent");
    await expect(first.usingFixture(() => Promise.reject(new Error("failed")))()).rejects.toThrow(
      "failed",
    );
    await first.cleanup();
    await expect(realpath(a.temporary)).rejects.toThrow();
    expect(await readFile(join(b.repo, "keep.txt"), "utf8")).toBe("independent");
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

it("isolates production Git from a fixture global config while retaining local config and stdin", async () => {
  const fixture = createWorktreeFixture();
  const { temporary, repo } = await fixture.create();
  try {
    // A fixture HOME tests the leak without reading or changing developer config.
    vi.stubEnv("HOME", temporary);
    vi.stubEnv("USERPROFILE", temporary);
    vi.stubEnv("XDG_CONFIG_HOME", join(temporary, "xdg"));
    await writeFile(join(temporary, ".gitconfig"), "[test]\n marker = global-must-not-leak\n");
    const { git: productionGit } = await import(
      "../../../../src/main/workspace/worktree-operations"
    );
    await expect(productionGit(repo, ["config", "--get", "test.marker"])).rejects.toThrow();
    await git(["config", "test.marker", "local-is-retained"], { cwd: repo });
    expect((await productionGit(repo, ["config", "--get", "test.marker"])).trim()).toBe(
      "local-is-retained",
    );
    const blob = await productionGit(
      repo,
      ["hash-object", "-w", "--stdin"],
      30_000,
      "fixture input",
    );
    expect(await productionGit(repo, ["cat-file", "blob", blob.trim()])).toBe("fixture input");
  } finally {
    await fixture.cleanup();
  }
});
