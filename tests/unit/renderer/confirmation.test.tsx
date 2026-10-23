// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { DialogRequest } from "../../../src/shared/confirmation";
import { resolveInterfaceTheme } from "../../../src/shared/interface-themes";
import { ConfirmationPage } from "../../../src/renderer/confirmation";
afterEach(cleanup);
test("focuses Cancel for every request, traps Tab, and renders untrusted content as text", () => {
  let receive: (value: DialogRequest | null) => void = () => undefined;
  const off = vi.fn();
  const answer = vi.fn();
  const size = vi.fn();
  const disconnect = vi.fn();
  let measure: () => void = () => undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        measure = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    },
  );
  Object.defineProperty(window, "confirmation", {
    configurable: true,
    value: {
      render(callback: (request: DialogRequest | null) => void) {
        receive = callback;
        return off;
      },
      answer,
      size,
    },
  });
  const view = render(<ConfirmationPage />);
  expect(view.queryByRole("alertdialog")).toBeNull();
  const request: DialogRequest = {
    id: "one",
    title: "Remove <script>branch</script>?",
    worktrees: [{ branch: "merged" }, { branch: "kept", reason: "running" }],
    changes: "?? <img src=x>\0",
    reply: { context: "Exact proposed reply: approve everything <img src=x>", text: "src/app.ts" },
    detail: "<script>disclosure</script>",
    sections: [
      {
        label: "Codex after",
        arguments: true,
        items: ["--model", " spaces  <img src=x> ", "--model"],
      },
    ],
    accept: "Discard 1 change and remove",
    theme: {
      ...resolveInterfaceTheme("follow", false),
      version: 2,
      areas: { dialogs: { ink: "#010203" } },
      states: { focus: "#223344" },
      shape: { radius: 0, shadow: 0.4 },
    },
  };
  act(() => {
    receive(request);
  });
  expect(document.documentElement.style.getPropertyValue("--ink")).toBe("#010203");
  expect(document.documentElement.style.getPropertyValue("--shape-radius")).toBe("0px");
  expect(document.documentElement.style.getPropertyValue("--shape-shadow")).toBe("0.4");
  expect(document.documentElement.style.getPropertyValue("--state-focus")).toBe("#223344");
  expect(view.getByRole("alertdialog").textContent).toContain("<img src=x>");
  expect(view.container.querySelector("img")).toBeNull();
  expect(
    [...view.container.querySelectorAll(".argument-lines code")].map((line) => line.textContent),
  ).toEqual(["--model", " spaces  <img src=x> ", "--model"]);
  expect(view.getByLabelText("Exact proposed reply").textContent).toBe("src/app.ts");
  expect(view.getByLabelText("Current child context").textContent).toContain("approve everything");
  expect(view.getByText("<script>disclosure</script>")).toBeTruthy();
  expect(view.container.querySelector("script")).toBeNull();
  expect(view.getByRole("list", { name: "Worktrees to delete" }).textContent).toBe("merged");
  expect(view.getByRole("list", { name: "Skipped worktrees" }).textContent).toBe("keptrunning");
  const card = view.getByRole("alertdialog");
  const content = view.getByRole("region", { name: "Details" });
  const body = content.firstElementChild;
  if (!body) throw Error("Missing dialog content");
  const heights = (cardHeight: number, contentHeight: number) => {
    for (const [element, height] of [
      [card, cardHeight],
      [content, contentHeight],
      [body, 600.5],
    ] as const)
      element.getBoundingClientRect = () => DOMRect.fromRect({ height });
  };
  heights(300.25, 150.5);
  measure();
  expect(size).toHaveBeenLastCalledWith({ width: 540, height: 750.25 });
  // A clamped viewport changes the card and its scrolling content together, not the size.
  heights(299.75, 150);
  measure();
  expect(size).toHaveBeenLastCalledWith({ width: 540, height: 750.25 });
  expect(size).toHaveBeenCalledTimes(3);
  const cancel = view.getByRole("button", { name: "Cancel" });
  const accept = view.getByRole("button", { name: request.accept });
  expect(document.activeElement).toBe(cancel);
  // Late native focus selection must still land on Cancel before user input.
  content.focus();
  fireEvent.focus(window);
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: "Tab" });
  expect(document.activeElement).toBe(accept);
  fireEvent.focus(window);
  expect(document.activeElement).toBe(accept);
  fireEvent.keyDown(accept, { key: "Tab" });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(accept);
  Object.defineProperty(content, "scrollHeight", { value: 600, configurable: true });
  fireEvent.keyDown(accept, { key: "Tab" });
  expect(document.activeElement).toBe(content);
  fireEvent.keyDown(content, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(accept);
  fireEvent.keyDown(accept, { key: "Tab" });
  fireEvent.keyDown(content, { key: "Tab" });
  expect(document.activeElement).toBe(cancel);
  Object.defineProperty(content, "scrollHeight", { value: 0 });
  fireEvent.keyDown(accept, { key: "Escape" });
  expect(answer).toHaveBeenLastCalledWith("one", false);
  fireEvent.click(cancel);
  fireEvent.click(accept);
  expect(answer).toHaveBeenLastCalledWith("one", true);
  act(() => {
    receive({
      id: "two",
      title: "Quit?",
      accept: "Stop all and quit",
      theme: resolveInterfaceTheme("follow", true),
      sessions: [{ id: "t", name: "shell", location: "/repo", state: "working" }],
    });
  });
  expect(document.activeElement).toBe(view.getByRole("button", { name: "Cancel" }));
  fireEvent.pointerDown(view.getByRole("button", { name: "Stop all and quit" }));
  view.getByRole("button", { name: "Stop all and quit" }).focus();
  fireEvent.focus(window);
  expect(document.activeElement).toBe(view.getByRole("button", { name: "Stop all and quit" }));
  expect(view.getByRole("img", { name: "Working" })).toBeTruthy();
  expect(document.documentElement.style.colorScheme).toBe("dark");
  fireEvent.keyDown(view.getByRole("alertdialog"), { key: "x" });
  for (const id of ["graphite", "eclipse-light", "deep-field", "eclipse-dark"] as const) {
    const theme = resolveInterfaceTheme(id, false);
    act(() => {
      receive({ ...request, id, theme });
    });
    expect(document.documentElement.style.getPropertyValue("--highlight")).toBe(
      theme.colors.highlight ?? theme.colors.accent,
    );
    expect(document.documentElement.style.getPropertyValue("--highlight-deep")).toBe(
      theme.colors["highlight-deep"] ?? theme.colors["accent-deep"],
    );
  }
  act(() => {
    receive(null);
  });
  expect(view.queryByRole("alertdialog")).toBeNull();
  view.unmount();
  expect(off).toHaveBeenCalledOnce();
  expect(disconnect).toHaveBeenCalled();
  vi.unstubAllGlobals();
});

test("cleanup checking, ready and run controls follow main state; Escape only hides", () => {
  let receive: (request: DialogRequest | null) => void = () => {};
  const answer = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, "confirmation", {
    configurable: true,
    value: {
      render(callback: typeof receive) {
        receive = callback;
        return () => {};
      },
      answer,
      size: vi.fn(),
    },
  });
  const view = render(<ConfirmationPage />);
  const base: DialogRequest = {
    id: "cleanup",
    title: "Delete merged worktrees?",
    accept: "Delete",
    theme: resolveInterfaceTheme("follow", false),
  };
  const progress = {
    total: 1,
    done: 0,
    phase: "fetch" as const,
    stopped: false,
    items: [{ id: "0", branch: "<script>", state: "queued" as const }],
  };
  act(() => {
    receive({ ...base, cleanup: { stage: "checking", checkingCount: 11, progress } });
  });
  expect(view.getByRole("heading", { name: "Checking11" })).toBeTruthy();
  expect(view.getByText("· fetching remote…")).toBeTruthy();
  expect(view.getByRole("button", { name: /^Delete$/u }).hasAttribute("disabled")).toBe(true);
  act(() => {
    receive({ ...base, cleanup: { stage: "ready", fetchedAt: Date.now() - 20000, progress } });
  });
  expect(view.getByText("· fetched 20 s ago")).toBeTruthy();
  expect(view.queryByText("queued")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Delete 1" }));
  expect(answer).toHaveBeenLastCalledWith("cleanup", true);
  act(() => {
    receive({
      ...base,
      cleanup: {
        stage: "run",
        progress: {
          ...progress,
          items: [
            { id: "removed", branch: "removed-tree", state: "removed" },
            {
              id: "branch-kept",
              branch: "removed-branch",
              state: "removed",
              reason: "branch kept",
            },
            { id: "removing", branch: "removing-tree", state: "removing" },
            { id: "queued", branch: "queued-tree", state: "queued" },
            { id: "kept", branch: "x".repeat(60), state: "kept", reason: "running" },
            { id: "failed", branch: "failed-tree", state: "error" },
          ],
        },
      },
    });
  });
  for (const word of ["removed", "removed · branch kept", "removing", "queued", "removal failed"])
    expect(view.getByText(word)).toBeTruthy();
  expect(view.getByRole("list", { name: "Kept worktrees" }).textContent).toBe(
    `${"x".repeat(60)}running`,
  );
  fireEvent.click(view.getByRole("button", { name: "Stop" }));
  expect(answer).toHaveBeenLastCalledWith("cleanup", true);
  act(() => {
    receive({
      ...base,
      cleanup: { stage: "run", progress: { ...progress, phase: "remove", stopped: true } },
    });
  });
  expect(view.getByRole("button", { name: "Stop" }).hasAttribute("disabled")).toBe(true);
  fireEvent.keyDown(view.getByRole("button", { name: "Hide" }), { key: "Escape" });
  expect(answer).toHaveBeenLastCalledWith("cleanup", false);
  const duplicateBranches = [
    {
      id: "first",
      branch: "Detached checkout",
      state: "kept" as const,
      reason: "unavailable" as const,
    },
    {
      id: "second",
      branch: "Detached checkout",
      state: "kept" as const,
      reason: "running" as const,
    },
    {
      id: "third",
      branch: "other",
      state: "kept" as const,
      reason: "uncommitted changes" as const,
    },
  ];
  act(() => {
    receive({
      ...base,
      cleanup: { stage: "run", progress: { ...progress, items: duplicateBranches } },
    });
  });
  act(() => {
    receive({
      ...base,
      cleanup: {
        stage: "run",
        progress: { ...progress, items: duplicateBranches.slice(1).reverse() },
      },
    });
  });
  const kept = view.getByRole("list", { name: "Kept worktrees" });
  expect(kept.children).toHaveLength(2);
  expect(kept.children[0]?.textContent).toBe("otheruncommitted changes");
  expect(kept.children[1]?.textContent).toBe("Detached checkoutrunning");
  act(() => {
    receive({
      ...base,
      cleanup: {
        stage: "run",
        progress: { ...progress, phase: "finished" },
        error: "fetch failed",
      },
    });
  });
  expect(view.getByText("fetch failed")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Done" }));
  expect(answer).toHaveBeenLastCalledWith("cleanup", false);
});

test("structured disclosures, git status words and pairing countdown render safely", () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  let receive: (request: DialogRequest | null) => void = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, "confirmation", {
    configurable: true,
    value: {
      render(callback: typeof receive) {
        receive = callback;
        return () => {};
      },
      answer: vi.fn(),
      size: vi.fn(),
    },
  });
  const view = render(<ConfirmationPage />);
  const base: DialogRequest = {
    id: "structured",
    title: "Pair?",
    accept: "Grant",
    theme: resolveInterfaceTheme("follow", false),
  };
  try {
    act(() => {
      receive({
        ...base,
        glyph: "link",
        subject: "CLI",
        pairing: { code: "<script>", expiresAt: 12500 },
        facts: [
          { label: "Repository", value: "/repo", mono: true },
          { label: "Grants", value: "Read only" },
        ],
        arguments: ["--yolo"],
        note: "Children stay with you",
        quiet: "Global config unchanged",
        sections: [{ label: "It reads", items: ["40 lines", "Likely secrets redacted"] }],
        changes:
          " M modified.ts\0?? untracked.ts\0 D deleted.ts\0R  new.ts\0old.ts\0C  copy.ts\0original.ts\0A  added.ts\0UU conflict.ts\0",
      });
    });
    expect(view.container.querySelector(".code strong")?.textContent).toBe("<script>");
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.querySelector(".subject")?.textContent).toBe("CLI · Expires in 3 s");
    expect(view.getByRole("heading", { name: "Discarded7" })).toBeTruthy();
    for (const word of [
      "modified",
      "untracked",
      "deleted",
      "renamed",
      "copied",
      "added",
      "unmerged",
    ])
      expect(view.getByText(word)).toBeTruthy();
    expect(view.getByText("← old.ts")).toBeTruthy();
    expect(view.getByText("← original.ts")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(view.container.querySelector(".subject")?.textContent).toBe("CLI · Expires in 2 s");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(view.container.querySelector(".subject")?.textContent).toBe("CLI · Expires in 0 s");
    expect(view.getByRole("button", { name: "Grant" }).hasAttribute("disabled")).toBe(true);
    act(() => {
      receive({
        ...base,
        changes: "",
        sessions: [{ id: "s", name: "shell", location: "x".repeat(60), state: "unknown" }],
      });
    });
    expect(view.getByRole("img", { name: "Quiet" })).toBeTruthy();
    expect(view.getByText("x".repeat(60))).toBeTruthy();
    act(() => {
      receive(null);
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    view.unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

test("batch review lists trusted snapshots, traps focus through selection and sends explicit IDs", () => {
  let receive: (value: DialogRequest | null) => void = () => undefined;
  const answer = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, "confirmation", {
    configurable: true,
    value: {
      render(callback: (value: DialogRequest | null) => void) {
        receive = callback;
        return () => undefined;
      },
      size: vi.fn(),
      answer,
    },
  });
  const view = render(<ConfirmationPage />);
  const request: DialogRequest = {
    id: "batch",
    title: "Remove worktrees?",
    accept: "Approve all",
    theme: resolveInterfaceTheme("follow", false),
    removals: [
      {
        id: "one",
        branch: "clean",
        path: "/trees/clean",
        changes: "",
        pullRequest: { number: 338, state: "MERGED" },
      },
      { id: "two", branch: "<img src=x>", path: "/trees/dirty", changes: "?? file\0" },
    ],
  };
  act(() => {
    receive(request);
  });
  expect(document.activeElement).toBe(view.getByRole("button", { name: "Decline" }));
  // The default action is Decline, including for a mixed clean/dirty batch.
  fireEvent.click(view.getByRole("button", { name: "Decline" }));
  expect(answer).toHaveBeenLastCalledWith("batch", false);
  expect(view.getByRole("list", { name: "Worktrees to remove" }).textContent).toContain("Clean");
  expect(view.getByText("Dirty")).toBeTruthy();
  expect(view.getByText("PR #338 · MERGED")).toBeTruthy();
  expect(view.getByText("/trees/dirty")).toBeTruthy();
  expect(view.getByRole("list", { name: "Uncommitted changes" }).textContent).toContain("file");
  expect(view.container.querySelector("img")).toBeNull();
  const subset = view.getByRole("button", { name: "Approve selected" });
  expect(subset.hasAttribute("disabled")).toBe(true);
  fireEvent.keyDown(document.activeElement ?? view.container, { key: "Tab" });
  expect(document.activeElement).toBe(
    view.getByRole("button", { name: "Discard changes and remove all" }),
  );
  fireEvent.keyDown(document.activeElement ?? view.container, { key: "Tab" });
  const checkbox = view.getByRole("checkbox", { name: "clean" });
  expect(document.activeElement).toBe(checkbox);
  fireEvent.click(checkbox);
  fireEvent.click(subset);
  expect(answer).toHaveBeenLastCalledWith("batch", ["one"]);
  fireEvent.click(checkbox);
  expect(subset.hasAttribute("disabled")).toBe(true);
  fireEvent.click(view.getByRole("checkbox", { name: "<img src=x>" }));
  fireEvent.click(view.getByRole("button", { name: "Discard changes and remove selected" }));
  expect(answer).toHaveBeenLastCalledWith("batch", ["two"]);
  act(() => {
    receive({ ...request, id: "updated" });
  });
  expect(view.getByRole("button", { name: "Approve selected" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(document.activeElement).toBe(view.getByRole("button", { name: "Decline" }));
  fireEvent.click(view.getByRole("button", { name: "Discard changes and remove all" }));
  expect(answer).toHaveBeenLastCalledWith("updated", ["one", "two"]);
  fireEvent.keyDown(view.getByRole("checkbox", { name: "clean" }), { key: "Escape" });
  expect(answer).toHaveBeenLastCalledWith("updated", false);
  fireEvent.click(view.getByRole("button", { name: "Decline" }));
  expect(answer).toHaveBeenLastCalledWith("updated", false);
  act(() => {
    receive({
      ...request,
      id: "clean-only",
      removals: [{ id: "one", branch: "clean", path: "/trees/clean", changes: "" }],
    });
  });
  fireEvent.click(view.getByRole("button", { name: "Approve all" }));
  expect(answer).toHaveBeenLastCalledWith("clean-only", ["one"]);
});

test("starts summaries collapsed, includes only visible disclosure controls in Tab order and resets each request", () => {
  let receive: (value: DialogRequest | null) => void = () => undefined;
  const answer = vi.fn();
  const size = vi.fn();
  let measure = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        measure = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, "confirmation", {
    configurable: true,
    value: {
      render(callback: typeof receive) {
        receive = callback;
        return () => undefined;
      },
      answer,
      size,
    },
  });
  const view = render(<ConfirmationPage />);
  const request: DialogRequest = {
    id: "collapsed",
    title: "Install?",
    accept: "Install",
    theme: resolveInterfaceTheme("follow", false),
    detail: "Runs as you.",
    sections: [
      { label: "Action", items: ["Install plugin"] },
      {
        label: "Checks",
        summary: [{ text: "1 ownership requirement" }],
        arguments: true,
        items: ['{"status":"owned"}'],
      },
      {
        label: "Files",
        summary: [
          { text: "1 file · 10000 bytes" },
          {
            text: "file · 0123456789ab · 10000 B",
            title: `file · SHA-256 ${"0123456789abcdef".repeat(4)} · 10000 B`,
          },
        ],
        arguments: true,
        items: ["<img src=x>".repeat(1000)],
      },
      { label: "Other", summary: [], items: ["Literal <script>text</script>"] },
    ],
  };
  act(() => {
    receive(request);
  });
  expect(view.getByText("Install plugin")).toBeTruthy();
  expect(view.getByText("Runs as you.").closest("details")).toBeNull();
  const card = view.getByRole("alertdialog");
  const content = view.getByRole("region", { name: "Details" });
  const body = content.firstElementChild;
  if (!body) throw Error("Missing content");
  for (const [element, height] of [
    [card, 800],
    [content, 650],
    [body, 2000],
  ] as const)
    element.getBoundingClientRect = () => DOMRect.fromRect({ height });
  measure();
  expect(size).toHaveBeenLastCalledWith({ width: 540, height: 800 });
  const details = [...view.container.querySelectorAll("details")];
  expect(details.every((detail) => !detail.open)).toBe(true);
  expect(view.getByText("1 file · 10000 bytes")).toBeTruthy();
  const digest = view.getByText("file · 0123456789ab · 10000 B");
  expect(digest.title).toBe(`file · SHA-256 ${"0123456789abcdef".repeat(4)} · 10000 B`);
  expect(digest.closest("summary")?.getAttribute("aria-label")).toContain(
    "0123456789abcdef".repeat(4),
  );
  const checks = details[0];
  const files = details[1];
  if (!checks || !files) throw Error("Missing disclosures");
  const cancel = view.getByRole("button", { name: "Cancel" });
  const accept = view.getByRole("button", { name: "Install" });
  fireEvent.keyDown(cancel, { key: "Tab" });
  expect(document.activeElement).toBe(accept);
  fireEvent.keyDown(accept, { key: "Tab" });
  expect(document.activeElement).toBe(checks.querySelector("summary"));
  fireEvent.keyDown(document.activeElement ?? view.container, { key: "Tab" });
  expect(document.activeElement).toBe(files.querySelector("summary"));
  files.open = true;
  fireEvent.keyDown(document.activeElement ?? view.container, { key: "Tab" });
  expect(document.activeElement).toBe(files.querySelector("code"));
  expect(files.querySelector("code")?.textContent).toBe("<img src=x>".repeat(1000));
  expect(view.container.querySelector("img")).toBeNull();
  fireEvent.keyDown(document.activeElement ?? view.container, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(files.querySelector("summary"));
  act(() => {
    receive({ ...request, id: "new" });
  });
  expect([...view.container.querySelectorAll("details")].every((detail) => !detail.open)).toBe(
    true,
  );
  expect(document.activeElement).toBe(
    cancel.isConnected ? cancel : view.getByRole("button", { name: "Cancel" }),
  );
  fireEvent.keyDown(view.getByRole("alertdialog"), { key: "Escape" });
  expect(answer).toHaveBeenLastCalledWith("new", false);
  vi.unstubAllGlobals();
});
