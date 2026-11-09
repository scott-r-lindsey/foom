// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ErrorPresentation } from "../../../../src/renderer/board/error-presentation";
import { Board } from "../../../../src/renderer/board/board-view";
import type { BoardSource } from "../../../../src/renderer/board/board-source.d";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import * as tiles from "../../../../src/renderer/board/tiles";
import * as audio from "../../../../src/renderer/sound/web-audio";
import { DEFAULT_SOUND } from "../../../../src/shared/sounds";
import type { SoundSettings } from "../../../../src/shared/sound";
import type { AppMenuApi } from "../../../../src/shared/app-menu";
import { boardRows } from "../../../fixtures/board";
import { setupState } from "../../../fixtures/setup";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

async function fixture(settings: SoundSettings = DEFAULT_SOUND, owner = true) {
  localStorage.clear();
  vi.useFakeTimers();
  const sink = {
    configure: vi.fn(),
    working: vi.fn(),
    alert: vi.fn(),
    silenceAlerts: vi.fn(),
    dispose: vi.fn(),
  };
  vi.spyOn(audio, "createAudioSink").mockReturnValue(sink);
  const data = createSampleSource(boardRows(0).slice(1, 2));
  const row = data.getSnapshot()[0];
  if (!row) throw new Error("Missing row");
  const forward = vi.fn(() => Promise.resolve());
  let session: Parameters<AppMenuApi["onSession"]>[0] | undefined;
  let place:
    | Parameters<NonNullable<NonNullable<BoardSource["previews"]>["onPlace"]>>[0]
    | undefined;
  const previewRows = [
    {
      id: "preview",
      repository: row.repository,
      worktree: `${row.repository}/${row.branch}`,
      relativePath: "page.html",
      kind: "html" as const,
      network: false,
    },
  ];
  const source: BoardSource = {
    ...data,
    appMenu: {
      platform: "linux",
      legal: () => Promise.resolve(""),
      onLegal: () => () => {},
      version: () => Promise.resolve({ app: "1", electron: "1" }),
      setView: async () => {},
      commands: () => Promise.resolve([]),
      shortcuts: () => Promise.resolve([]),
      execute: async () => {},
      onOpen: () => () => {},
      onShortcuts: () => () => {},
      onSession: (callback) => {
        session = callback;
        return () => {};
      },
    },
    windows: {
      id: "refusal",
      number: 1,
      initialSession: undefined,
      sync: (ids) => Promise.resolve(ids),
      select: () => Promise.resolve(true),
      popout: async () => {},
      snapshot: () => Promise.resolve([]),
      onChanged: () => () => {},
      onRemoved: () => () => {},
      audio: {
        state: () => Promise.resolve({ enabled: owner, focusedId: null }),
        focus: async () => {},
        refuse: forward,
        onChanged: () => () => {},
        onRefuse: () => () => {},
      },
    },
    previews: {
      getSnapshot: () => previewRows,
      pick: () => Promise.resolve("preview"),
      bounds: async () => {},
      close: async () => {},
      onPlace: (callback) => {
        place = callback;
        return () => {};
      },
    },
  };
  const state = setupState();
  const view = render(
    <ErrorPresentation>
      <Board
        source={source}
        soundSetup={{
          state: () =>
            Promise.resolve({ ...state, settings: { ...state.settings, sound: settings } }),
          subscribe: () => () => {},
        }}
      />
    </ErrorPresentation>,
  );
  await act(async () => {});
  // Inject placement failure at the board boundary; tile limit geometry is tested separately.
  vi.spyOn(tiles, "placeSession").mockReturnValue(null);
  vi.spyOn(tiles, "placeContent").mockReturnValue(null);
  return {
    view,
    sink,
    forward,
    terminal: async (background = false) => {
      await act(async () => {
        session?.(row.id, background);
        await Promise.resolve();
      });
    },
    preview: () => fireEvent.click(view.getByRole("button", { name: "page.html" })),
    agentPreview: async () => {
      vi.spyOn(tiles, "placeAgentPreview").mockImplementation((layout) => ({
        layout,
        placement: "sidebar",
      }));
      await act(async () => {
        expect(await place?.("preview", Date.now() + 10000)).toBe("sidebar");
      });
    },
  };
}

test.each(["terminal", "preview"] as const)(
  "foreground %s refusal sounds once and retains its message",
  async (kind) => {
    const f = await fixture();
    await f[kind]();
    expect(f.sink.alert).toHaveBeenCalledExactlyOnceWith("refusal", DEFAULT_SOUND.alertVolume);
    expect(f.forward).not.toHaveBeenCalled();
    expect(f.view.getByText("The tile layout has reached its size limit.")).toBeTruthy();
  },
);

test.each([{ alerts: false }, { alertVolume: 0 }])(
  "placement refusals respect %j",
  async (patch) => {
    const f = await fixture({ ...DEFAULT_SOUND, ...patch });
    await f.terminal();
    f.preview();
    expect(f.sink.alert).not.toHaveBeenCalled();
    expect(f.view.getByText("The tile layout has reached its size limit.")).toBeTruthy();
  },
);

test("background terminal and agent preview placement failures stay silent", async () => {
  const f = await fixture();
  await f.terminal(true);
  expect(f.view.getByLabelText("Show failure")).toBeTruthy();
  await f.agentPreview();
  expect(f.sink.alert).not.toHaveBeenCalled();
  expect(f.forward).not.toHaveBeenCalled();
});

test.each(["terminal", "preview"] as const)(
  "secondary window forwards %s refusal once and tolerates bridge failure",
  async (kind) => {
    const f = await fixture(DEFAULT_SOUND, false);
    f.forward.mockRejectedValueOnce(new Error("Audio owner closed"));
    await f[kind]();
    expect(f.forward).toHaveBeenCalledOnce();
    expect(f.sink.alert).not.toHaveBeenCalled();
    expect(f.view.getByText("The tile layout has reached its size limit.")).toBeTruthy();
  },
);
