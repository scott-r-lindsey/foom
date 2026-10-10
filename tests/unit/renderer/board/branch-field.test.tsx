// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import {
  CONVENTIONAL_PREFIXES,
  branchCandidates,
  branchOutcome,
  branchPrefixes,
  normalizeBranch,
  pendingText,
  refProblem,
} from "../../../../src/renderer/board/branch-field";
import { BranchField } from "../../../../src/renderer/board/branch-field-view";
import type { BranchInventory } from "../../../../src/shared/worktrees";

const data: BranchInventory = {
  head: "main",
  local: [
    { name: "main", worktree: "/repos/foom" },
    { name: "codex/issue-1", worktree: "/trees/foom-1" },
    { name: "codex/issue-2", worktree: null },
    { name: "docs/guide", worktree: null },
    { name: "fix-typo", worktree: null },
  ],
  remote: "origin",
  remoteBranches: ["main", "codex/remote", "spike/x-codex"],
};
const bare: BranchInventory = { head: "main", local: [], remote: null, remoteBranches: [] };

afterEach(cleanup);

test("candidates: repository prefixes by use, then starts-with, then contains", () => {
  expect(branchPrefixes(data)).toEqual(["codex/", "docs/", "spike/"]);
  expect(branchPrefixes(bare)).toEqual(CONVENTIONAL_PREFIXES);
  expect(branchCandidates(bare, "f").map((candidate) => candidate.value)).toEqual([
    "feat/",
    "fix/",
  ]);
  expect(branchCandidates(data, "")).toEqual([
    { value: "codex/", inline: true },
    { value: "docs/", inline: true },
    { value: "spike/", inline: true },
    { value: "codex/issue-1", inline: true },
    { value: "codex/issue-2", inline: true },
    { value: "docs/guide", inline: true },
    { value: "fix-typo", inline: true },
    { value: "codex/remote", inline: true },
    { value: "spike/x-codex", inline: true },
  ]);
  // Once a prefix is typed, prefixes stop competing; the head branch is never offered.
  expect(branchCandidates(data, "codex/")).toEqual([
    { value: "codex/issue-1", inline: true },
    { value: "codex/issue-2", inline: true },
    { value: "codex/remote", inline: true },
  ]);
  expect(branchCandidates(data, "CODEX").map((candidate) => candidate.inline)).toEqual([
    false,
    false,
    false,
    false,
  ]);
  expect(branchCandidates(data, "ma")).toEqual([]);
});

test("the status line says what Enter does with exactly what is typed", () => {
  expect(branchOutcome(data, "")).toBeUndefined();
  expect(branchOutcome(data, "codex/")).toBeUndefined();
  expect(branchOutcome(data, "codex/new")).toEqual({ kind: "new", text: "new, from main" });
  expect(branchOutcome({ ...data, head: null }, "x")).toEqual({
    kind: "new",
    text: "new, from HEAD",
  });
  expect(branchOutcome(data, "codex/issue-2")).toEqual({ kind: "existing", text: "existing" });
  expect(branchOutcome(data, "codex/remote")).toEqual({ kind: "origin", text: "from origin" });
  expect(branchOutcome({ ...data, remote: null }, "codex/remote")?.text).toBe("from origin");
  expect(branchOutcome(data, "codex/issue-1")).toEqual({ kind: "open", text: "open in foom-1" });
  expect(branchOutcome(data, "main")).toEqual({ kind: "open", text: "open in foom" });
  expect(branchOutcome(data, "a..b")).toEqual({ kind: "invalid", text: "Can't contain .." });
  expect(pendingText(data, "new")).toBe("Creating from main…");
  expect(pendingText({ ...data, head: null }, "new")).toBe("Creating from HEAD…");
  expect(pendingText(data, "origin")).toBe("Checking out…");
});

test("ref rules mirror git check-ref-format --branch", () => {
  expect(normalizeBranch("fix the bug")).toBe("fix-the-bug");
  for (const [name, problem] of [
    ["-x", "Can't start with -"],
    ["HEAD", "Can't be HEAD"],
    ["@", "Can't be @"],
    ["a..b", "Can't contain .."],
    ["a~1", "Can't contain ~ ^ : ? * [ or \\"],
    ["a^", "Can't contain ~ ^ : ? * [ or \\"],
    ["a:b", "Can't contain ~ ^ : ? * [ or \\"],
    ["a?", "Can't contain ~ ^ : ? * [ or \\"],
    ["a*", "Can't contain ~ ^ : ? * [ or \\"],
    ["a[b", "Can't contain ~ ^ : ? * [ or \\"],
    ["a\\b", "Can't contain ~ ^ : ? * [ or \\"],
    ["a\tb", "Can't contain ~ ^ : ? * [ or \\"],
    ["a@{1}", "Can't contain @{"],
    ["/a", "Each part needs a name and can't start with ."],
    ["a//b", "Each part needs a name and can't start with ."],
    [".a", "Each part needs a name and can't start with ."],
    ["a/.b", "Each part needs a name and can't start with ."],
    ["a.lock/b", "A part can't end with .lock"],
    ["a.lock", "A part can't end with .lock"],
    ["a.", "Can't end with ."],
  ] as const)
    expect(refProblem(name), name).toBe(problem);
  for (const name of ["feat/x", "codex/", "a.b", "a@b", "x-1/y_2"])
    expect(refProblem(name), name).toBeUndefined();
});

test("arrival honours reduced motion and uses the accent, not amber", async () => {
  const css = await readFile("src/renderer/styles/branch-field.css", "utf8");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  expect(reduced).toMatch(
    /\.worktree-row\.arriving,\s*\.worktree-row\.arriving::after\s*\{\s*animation: none;/u,
  );
  // The tint and edge stay without motion.
  expect(css).toMatch(
    /\.worktree-row\.arriving \{[^}]*box-shadow: inset 2px 0 0 var\(--highlight\)/u,
  );
  expect(css).not.toMatch(/--attention/u);
});

function setup(
  branches = vi.fn(() => Promise.resolve(data)),
  create = vi.fn((_repository: string, branch: string) =>
    Promise.resolve({
      path: `/trees/${branch}`,
      branch,
      head: "abc",
      bare: false,
      locked: false,
      prunable: false,
      managed: true,
      outcome: "new" as const,
    }),
  ),
) {
  const back = vi.fn();
  const created = vi.fn();
  const view = render(
    <BranchField
      repository="/repos/foom"
      source={{ branches, create }}
      back={back}
      created={created}
    />,
  );
  const input = view.getByLabelText("Branch for the new worktree");
  if (!(input instanceof HTMLInputElement)) throw new Error("The field is not an input");
  const status = () => view.getByRole("status");
  const ghost = () => view.container.querySelector(".branch-ghost")?.textContent ?? "";
  return { ...view, input, status, ghost, back, created, branches, create };
}

test("typing turns spaces into -, Tab completes and Up and Down cycle", async () => {
  const view = setup();
  await act(async () => {
    await Promise.resolve();
  });
  expect(document.activeElement).toBe(view.input);
  expect(view.input.placeholder).toBe("");
  expect(view.ghost()).toBe("codex/ ⇥");
  fireEvent.keyDown(view.input, { key: "ArrowDown" });
  expect(view.ghost()).toBe("docs/ ⇥");
  fireEvent.keyDown(view.input, { key: "ArrowUp" });
  fireEvent.keyDown(view.input, { key: "ArrowUp" });
  expect(view.ghost()).toBe("spike/x-codex ⇥");
  fireEvent.keyDown(view.input, { key: "Tab" });
  expect(view.input.value).toBe("spike/x-codex");
  fireEvent.change(view.input, { target: { value: "codex/my task" } });
  expect(view.input.value).toBe("codex/my-task");
  expect(view.status().textContent).toBe("new, from main");
  expect(view.status().dataset["kind"]).toBe("new");
  // A candidate that only contains the text shows right-aligned, completing on Tab.
  fireEvent.change(view.input, { target: { value: "x-co" } });
  expect(view.container.querySelector(".branch-other")?.textContent).toBe("spike/x-codex ⇥");
  fireEvent.keyDown(view.input, { key: "Tab", shiftKey: true });
  expect(view.input.value).toBe("x-co");
  fireEvent.change(view.input, { target: { value: "a..b" } });
  expect(view.status().textContent).toBe("Can't contain ..");
  expect(view.input.getAttribute("aria-invalid")).toBe("true");
  expect(view.container.querySelector(".branch-box")?.hasAttribute("data-invalid")).toBe(true);
  // Enter does nothing for an invalid name or a bare prefix.
  fireEvent.keyDown(view.input, { key: "Enter" });
  fireEvent.change(view.input, { target: { value: "codex/" } });
  fireEvent.keyDown(view.input, { key: "Enter" });
  expect(view.create).not.toHaveBeenCalled();
  expect(view.status().textContent).toBe("");
  // Left Arrow returns only from an empty field; Escape always does.
  fireEvent.keyDown(view.input, { key: "ArrowLeft" });
  expect(view.back).not.toHaveBeenCalled();
  fireEvent.keyDown(view.input, { key: "Escape" });
  expect(view.back).toHaveBeenCalledOnce();
  fireEvent.change(view.input, { target: { value: "" } });
  fireEvent.keyDown(view.input, { key: "ArrowLeft" });
  expect(view.back).toHaveBeenCalledTimes(2);
});

test("Enter disables the field while main works and creates without launching", async () => {
  let finish: (value: never) => void = () => {};
  const create = vi.fn(
    () =>
      new Promise<never>((resolve) => {
        finish = resolve;
      }),
  );
  const view = setup(undefined, create);
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.change(view.input, { target: { value: "codex/remote" } });
  expect(view.status().textContent).toBe("from origin");
  fireEvent.keyDown(view.input, { key: "Enter" });
  expect(view.input.disabled).toBe(true);
  expect(view.status().textContent).toBe("Checking out…");
  fireEvent.keyDown(view.input, { key: "Enter" });
  expect(create).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledWith("/repos/foom", "codex/remote");
  await act(async () => {
    finish({ path: "/trees/remote", outcome: "origin" } as never);
    await Promise.resolve();
  });
  expect(view.created).toHaveBeenCalledWith({ path: "/trees/remote", outcome: "origin" });
});

test("a failure shows git's message and re-enables the field", async () => {
  const create = vi.fn(() =>
    Promise.reject(
      new Error(
        "Error invoking remote method 'workspace:create-worktree': Error: fatal: cannot lock ref",
      ),
    ),
  );
  const view = setup(undefined, create);
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.change(view.input, { target: { value: "codex/new" } });
  fireEvent.keyDown(view.input, { key: "Enter" });
  expect(view.status().textContent).toBe("Creating from main…");
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.input.disabled).toBe(false);
  expect(document.activeElement).toBe(view.input);
  expect(view.status().textContent).toBe("fatal: cannot lock ref");
  expect(view.status().hasAttribute("data-invalid")).toBe(true);
  expect(view.created).not.toHaveBeenCalled();
  fireEvent.change(view.input, { target: { value: "codex/newer" } });
  expect(view.status().textContent).toBe("new, from main");
  create.mockRejectedValueOnce("denied");
  await act(async () => {
    fireEvent.keyDown(view.input, { key: "Enter" });
    await Promise.resolve();
  });
  expect(view.status().textContent).toBe("Unable to create the worktree.");
});

test("without branch data the field still creates and says why completions are missing", async () => {
  const view = setup(vi.fn(() => Promise.reject(new Error("not a repository"))));
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.ghost()).toBe("feat/ ⇥");
  fireEvent.change(view.input, { target: { value: "topic" } });
  expect(view.status().textContent).toBe("not a repository");
  fireEvent.change(view.input, { target: { value: "-x" } });
  expect(view.status().textContent).toBe("Can't start with -");
  fireEvent.change(view.input, { target: { value: "topic" } });
  await act(async () => {
    fireEvent.keyDown(view.input, { key: "Enter" });
    await Promise.resolve();
  });
  expect(view.create).toHaveBeenCalledWith("/repos/foom", "topic");
});

test("branch data arriving after unmount is ignored", async () => {
  let deliver: (value: BranchInventory) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const view = setup(
    vi.fn<() => Promise<BranchInventory>>().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    ),
  );
  view.unmount();
  const second = setup(
    vi.fn(
      () =>
        new Promise<BranchInventory>((_resolve, reject) => {
          fail = reject;
        }),
    ),
  );
  second.unmount();
  await act(async () => {
    deliver(data);
    fail(new Error("late"));
    await Promise.resolve();
  });
  expect(view.container.textContent).toBe("");
});
