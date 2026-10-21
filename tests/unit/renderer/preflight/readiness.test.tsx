// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ReadinessStep } from "../../../../src/renderer/preflight/readiness-step";
import { useReadiness } from "../../../../src/renderer/preflight/use-readiness";
import type { ReadinessReport } from "../../../../src/shared/readiness";
import { setupState, report } from "../../../fixtures/setup";
afterEach(cleanup);
const ready: ReadinessReport = { git: "ready", platform: "linux", forges: [] };
test.each([
  ["macos", "not-installed", "xcode-select --install"],
  ["windows", "invalid-version", "Git for Windows"],
  ["linux", "unavailable", "apt install git"],
] as const)("git remediation on %s shows fixed installation guidance", (platform, git, hint) => {
  const recheck = vi.fn();
  render(
    <ReadinessStep
      headingRef={{ current: null }}
      state={setupState()}
      report={report()}
      repositories={[]}
      go={vi.fn()}
      readiness={{
        report: { ...ready, platform, git },
        busy: false,
        error: false,
        recheck,
        commands: new Map(),
      }}
    />,
  );
  expect(screen.getByText(new RegExp(hint))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
  expect(recheck).toHaveBeenCalledOnce();
});
test("readiness retires stale replies, reports failures and refreshes on demand", async () => {
  let finish: (report: ReadinessReport) => void = () => {};
  const check = vi
    .fn<() => Promise<ReadinessReport>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockRejectedValueOnce(new Error("private diagnostic"))
    .mockResolvedValue(ready);
  const source = { checkReadiness: check };
  const view = renderHook(({ active, revision }) => useReadiness(source, active, revision), {
    initialProps: { active: true, revision: "one" },
  });
  expect(view.result.current.busy).toBe(true);
  view.rerender({ active: true, revision: "two" });
  await waitFor(() => {
    expect(view.result.current.error).toBe(true);
  });
  act(() => {
    finish(ready);
  });
  expect(view.result.current.report).toBeUndefined();
  act(() => {
    view.result.current.recheck();
  });
  await waitFor(() => {
    expect(view.result.current.report).toEqual(ready);
  });
  view.rerender({ active: false, revision: "two" });
  expect(check).toHaveBeenCalledTimes(3);
});
test("unmount ignores rejected pending requests", () => {
  let reject: (error: Error) => void = () => {};
  const source = {
    checkReadiness: () =>
      new Promise<ReadinessReport>((_resolve, fail) => {
        reject = fail;
      }),
  };
  const view = renderHook(() => useReadiness(source, true, "one"));
  view.unmount();
  act(() => {
    reject(new Error("private"));
  });
});

test("login hints use only approved fixed commands from the current valid catalog", async () => {
  const source = {
    checkReadiness: () => Promise.resolve(ready),
    config: {
      status: vi.fn(() =>
        Promise.resolve({
          folder: "/config",
          available: true,
          pending: null,
          rejected: [],
          forgePlugins: [
            { id: "github", name: "GitHub", badge: "GH", executables: ["gh"] },
            { id: "gitlab", name: "GitLab fixture", badge: "GL", executables: ["other", "glab"] },
            { id: "custom", name: "Custom", badge: "CF", executables: ["custom"] },
            { id: "invalid", name: "Rejected", badge: "?", executables: ["gh"], reason: "invalid" },
          ],
        }),
      ),
      decide: vi.fn(),
      openFolder: vi.fn(),
      subscribe: () => () => {},
    },
  };
  const view = renderHook(() => useReadiness(source, true, "one"));
  await waitFor(() => {
    expect(view.result.current.commands.get("gitlab")).toBe("glab auth login");
  });
  expect(view.result.current.commands.get("github")).toBe("gh auth login");
  expect(view.result.current.commands.has("custom")).toBe(false);
  expect(view.result.current.commands.has("invalid")).toBe(false);
});
test("a missing catalog, late catalog or catalog read failure never holds readiness", async () => {
  let finish: (catalog: {
    folder: string;
    available: boolean;
    pending: null;
    rejected: [];
  }) => void = () => {};
  const status = vi.fn(
    () =>
      new Promise<{ folder: string; available: boolean; pending: null; rejected: [] }>(
        (resolve) => {
          finish = resolve;
        },
      ),
  );
  const source = {
    checkReadiness: () => Promise.resolve(ready),
    config: { status, decide: vi.fn(), openFolder: vi.fn(), subscribe: () => () => {} },
  };
  const view = renderHook(() => useReadiness(source, true, "one"));
  await waitFor(() => {
    expect(view.result.current.report).toEqual(ready);
  });
  view.unmount();
  finish({ folder: "/config", available: true, pending: null, rejected: [] });
  status.mockResolvedValueOnce({ folder: "/config", available: true, pending: null, rejected: [] });
  const empty = renderHook(() => useReadiness(source, true, "two"));
  await waitFor(() => {
    expect(empty.result.current.report).toEqual(ready);
  });
  status.mockRejectedValueOnce(new Error("private diagnostic"));
  act(() => {
    empty.result.current.recheck();
  });
  await waitFor(() => {
    expect(status).toHaveBeenCalledTimes(3);
  });
});
