import type { ReactNode } from "react";
import type { RenderOptions } from "@testing-library/react";
import {
  ErrorPresentation,
  BackgroundErrorMark,
} from "../../../../src/renderer/board/error-presentation";
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ForgesSettings } from "../../../../src/renderer/preflight/forges-settings";
import { Preflight } from "../../../../src/renderer/preflight/preflight-view";
import type { SettingsPatch } from "../../../../src/shared/setup";
import type { ConfigStatus } from "../../../../src/shared/foom-config";
import type { SetupSource } from "../../../../src/renderer/preflight/setup-source.d";
import { setupState, report } from "../../../fixtures/setup";

const render = (ui: ReactNode, options?: RenderOptions) =>
  renderView(ui, {
    ...options,
    wrapper: ({ children }) => (
      <ErrorPresentation>
        {children}
        <BackgroundErrorMark />
      </ErrorPresentation>
    ),
  });

afterEach(cleanup);
const catalog: ConfigStatus = {
  folder: "/config",
  available: true,
  pending: null,
  rejected: [],
  forgePlugins: [
    {
      id: "github",
      name: "Rejected GitHub",
      badge: "?",
      executables: [],
      file: "forges/github.json",
      reason: "$.id: reserved-id",
    },
    { id: "github", name: "GitHub", badge: "GH", executables: ["gh"] },
    {
      id: "custom",
      name: "Custom forge",
      badge: "CF",
      executables: ["fixture-gh"],
      file: "forges/custom.json",
    },
    {
      id: "broken",
      name: "Broken",
      badge: "?",
      executables: [],
      file: "forges/broken.json",
      reason: "$: invalid-manifest",
    },
  ],
};
function fixture(status: Promise<ConfigStatus> = Promise.resolve(catalog)) {
  let listener: ((value: ConfigStatus) => void) | undefined;
  const dispose = vi.fn();
  const source: SetupSource = {
    state: () => Promise.resolve(setupState()),
    save: () => Promise.resolve(setupState()),
    scanAgents: () => Promise.resolve(report()),
    changeAgyPlugin: () => Promise.resolve(report()),
    repositories: () => Promise.resolve([]),
    suggestions: () => Promise.resolve([]),
    scan: () => Promise.resolve(null),
    apply: () => Promise.resolve({ repositories: [], failures: [] }),
    subscribe: () => () => {},
    openThemesFolder: () => Promise.resolve(),
    config: {
      status: () => status,
      subscribe: (receive) => {
        listener = receive;
        return dispose;
      },
      openFolder: () => Promise.resolve(),
      decide: () => Promise.resolve(catalog),
    },
  };
  const props = {
    headingRef: { current: null },
    settings: setupState().settings,
    source,
    save: vi.fn(() => Promise.resolve()),
  };
  return {
    props,
    source,
    dispose,
    update: (value: ConfigStatus) => {
      listener?.(value);
    },
  };
}
test("cards show source and rejection, start copies off, and submit main-owned preferences", async () => {
  const f = fixture();
  render(<ForgesSettings {...f.props} />);
  const github = await screen.findByRole("region", { name: "GitHub" });
  expect(within(github).getByText("Built-in")).toBeTruthy();
  expect(within(github).getByText("Not checked")).toBeTruthy();
  expect(within(github).getByRole("switch").hasAttribute("checked")).toBe(true);
  expect(screen.queryByRole("button", { name: /Duplicate|Approve/ })).toBeNull();
  const custom = screen.getByRole("region", { name: "Custom forge" });
  expect(within(custom).getByText("forges/custom.json")).toBeTruthy();
  expect(within(custom).getByRole("textbox").hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("$: invalid-manifest")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Broken" }))
      .getByRole("switch")
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(within(custom).getByRole("switch"));
  await waitFor(() => {
    expect(f.props.save).toHaveBeenCalledWith({ forges: { github: true, custom: true } });
  });
  await waitFor(() => {
    expect(within(github).getByRole("switch").hasAttribute("disabled")).toBe(false);
  });
  fireEvent.click(within(github).getByRole("switch"));
  await waitFor(() => {
    expect(f.props.save).toHaveBeenCalledWith({ forges: { github: false } });
  });
  await waitFor(() => {
    expect(within(github).getByRole("textbox").hasAttribute("disabled")).toBe(false);
  });
  fireEvent.change(within(github).getByRole("textbox"), { target: { value: "git.example.org" } });
  fireEvent.click(within(github).getByRole("button", { name: "Assign host" }));
  await waitFor(() => {
    expect(f.props.save).toHaveBeenCalledWith({
      forgeHosts: { "github.com": "github", "git.example.org": "github" },
    });
  });
  await waitFor(() => {
    expect(
      within(github).getByRole("button", { name: "Remove github.com" }).hasAttribute("disabled"),
    ).toBe(false);
  });
  fireEvent.click(within(github).getByRole("button", { name: "Remove github.com" }));
  await waitFor(() => {
    expect(f.props.save).toHaveBeenCalledWith({ forgeHosts: {} });
  });
});
test("save failures display main's error; empty and invalid host input is submitted without renderer normalization", async () => {
  const f = fixture();
  f.props.save.mockRejectedValue(new Error("Use a lowercase DNS hostname"));
  render(<ForgesSettings {...f.props} />);
  const github = await screen.findByRole("region", { name: "GitHub" });
  fireEvent.click(within(github).getByRole("button", { name: "Assign host" }));
  await screen.findByRole("alert");
  expect(f.props.save).toHaveBeenCalledWith({
    forgeHosts: { "github.com": "github", "": "github" },
  });
  fireEvent.change(within(github).getByRole("textbox"), { target: { value: "HTTPS://Bad/" } });
  fireEvent.click(within(github).getByRole("button", { name: "Assign host" }));
  await waitFor(() => {
    expect(f.props.save).toHaveBeenCalledWith({
      forgeHosts: { "github.com": "github", "HTTPS://Bad/": "github" },
    });
  });
});
test("catalog subscriptions update cards, retain missing assignments and dispose on unmount", async () => {
  const f = fixture();
  f.props.settings.forgeHosts = { "git.example.org": "absent" };
  const view = render(<ForgesSettings {...f.props} />);
  await screen.findByRole("region", { name: "GitHub" });
  expect(screen.getByText("absent · Unavailable")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove git.example.org" }));
  await waitFor(() => {
    expect(f.props.save).toHaveBeenCalledWith({ forgeHosts: {} });
  });
  act(() => {
    f.update({ ...catalog, forgePlugins: [] });
  });
  expect(screen.queryByRole("region", { name: "GitHub" })).toBeNull();
  view.unmount();
  expect(f.dispose).toHaveBeenCalledOnce();
  act(() => {
    f.update(catalog);
  });
});
test("load errors surface and late completions after unmount are ignored", async () => {
  const failed = fixture(Promise.reject(new Error("Catalog unavailable")));
  render(<ForgesSettings {...failed.props} />);
  expect(await screen.findByText("Unable to load forge settings.")).toBeTruthy();
  cleanup();
  let resolve: ((value: ConfigStatus) => void) | undefined;
  const late = fixture(
    new Promise<ConfigStatus>((done) => {
      resolve = done;
    }),
  );
  const view = render(<ForgesSettings {...late.props} />);
  view.unmount();
  await act(() => {
    resolve?.(catalog);
    return Promise.resolve();
  });
  let reject: ((value: Error) => void) | undefined;
  const lateFailure = fixture(
    new Promise<ConfigStatus>((_, fail) => {
      reject = fail;
    }),
  );
  const failureView = render(<ForgesSettings {...lateFailure.props} />);
  failureView.unmount();
  await act(() => {
    reject?.(new Error("Late failure"));
    return Promise.resolve();
  });
});
test("works without a config source or optional catalog", async () => {
  const empty = { ...catalog };
  delete empty.forgePlugins;
  const f = fixture(Promise.resolve(empty));
  render(<ForgesSettings {...f.props} />);
  await act(() => Promise.resolve());
  cleanup();
  delete f.source.config;
  render(<ForgesSettings {...f.props} />);
  expect(screen.getByRole("heading", { name: "Forges" })).toBeTruthy();
});
test("Settings navigation reaches Forges and persists through the source coordinator", async () => {
  const f = fixture();
  const save = vi.fn((patch: SettingsPatch) => Promise.resolve(setupState(patch)));
  f.source.save = save;
  render(
    <Preflight
      source={f.source}
      initial={setupState()}
      onLaunched={() => {}}
      settingsMode
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Forges" }));
  const github = await screen.findByRole("region", { name: "GitHub" });
  fireEvent.click(within(github).getByRole("switch"));
  await waitFor(() => {
    expect(save).toHaveBeenCalledWith({ forges: { github: false } });
  });
  await waitFor(() => {
    expect(within(github).getByText("Turned off")).toBeTruthy();
  });
});

test("rejected definitions never display a valid manifest's host authority", async () => {
  const f = fixture();
  f.props.settings.forgeHosts = { "github.com": "github", "git.example.org": "broken" };
  render(<ForgesSettings {...f.props} />);
  const rejected = await screen.findByRole("region", { name: "Rejected GitHub" });
  expect(within(rejected).queryByText("github.com")).toBeNull();
  expect(screen.getAllByRole("button", { name: "Remove github.com" })).toHaveLength(1);
  expect(
    within(screen.getByRole("region", { name: "Broken" })).queryByText("git.example.org"),
  ).toBeNull();
  expect(screen.getByText("broken · Unavailable")).toBeTruthy();
});
