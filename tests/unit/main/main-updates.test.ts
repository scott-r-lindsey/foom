import { updateMock, mock } from "./main-fixture";
import { DEFAULT_SETTINGS } from "../../../src/main/setup/settings";

import { expect, test, vi } from "vitest";

test("downloaded macOS restart waits for confirmation and PTY shutdown before native installation", async ({
  onTestFinished,
}) => {
  updateMock.getRelease.mockResolvedValueOnce({
    url: "https://github.com/scott-r-lindsey/foom/releases/download/v0.2.0/Foom-darwin-arm64-0.2.0.zip",
  });
  vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  mock.packaged = true;
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: "/test/resources" });
  onTestFinished(() => {
    Reflect.deleteProperty(process, "resourcesPath");
  });
  vi.spyOn(mock.settingsStore, "get").mockReturnValue({
    ...DEFAULT_SETTINGS,
    checkForUpdates: true,
  });
  const { runApplication } = await import("../../../src/main/wiring/application");
  const wiring = runApplication();
  await vi.waitFor(() => {
    expect(mock.window.loadURL).toHaveBeenCalled();
  });
  wiring.updates.configure(true);
  await vi.waitFor(() => {
    expect(updateMock.updater.checkForUpdates).toHaveBeenCalledOnce();
  });
  expect(updateMock.prepareUpdate).toHaveBeenCalledWith(
    "/test/user-data",
    {
      version: "0.2.0",
      url: "https://github.com/scott-r-lindsey/foom/releases/download/v0.2.0/Foom-darwin-arm64-0.2.0.zip",
    },
    expect.any(AbortSignal),
  );
  const downloaded = updateMock.updater.on.mock.calls.find(
    ([event]) => event === "update-downloaded",
  )?.[1];
  if (typeof downloaded !== "function") throw new Error("Missing native update listener");
  downloaded();
  expect(updateMock.updater.quitAndInstall).not.toHaveBeenCalled();
  mock.terminals.runningCount = 1;
  await wiring.updates.restartToUpdate(); // Cancel defaults to response 0.
  expect(mock.terminals.shutdown).not.toHaveBeenCalled();
  expect(updateMock.updater.quitAndInstall).not.toHaveBeenCalled();
  mock.message.mockResolvedValue({ response: 1 });
  let finish: () => void = () => {};
  mock.terminals.shutdown.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const quitting = wiring.updates.restartToUpdate();
  await vi.waitFor(() => {
    expect(mock.terminals.shutdown).toHaveBeenCalledOnce();
  });
  expect(updateMock.updater.quitAndInstall).not.toHaveBeenCalled();
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  finish();
  await vi.waitFor(() => {
    expect(updateMock.updater.quitAndInstall).toHaveBeenCalledOnce();
  });
  await quitting;
  expect(mock.workspace.dispose).toHaveBeenCalled();
  expect(updateMock.updater.quitAndInstall).toHaveBeenCalledOnce();
  expect(mock.quit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(mock.quit).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(mock.exit).toHaveBeenCalledWith(0);
});

test("stable Linux startup uses only the fake anonymous release HTTP adapter", async ({
  onTestFinished,
}) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  mock.packaged = true;
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: "/test/resources" });
  onTestFinished(() => {
    Reflect.deleteProperty(process, "resourcesPath");
  });
  vi.spyOn(mock.settingsStore, "get").mockReturnValue({
    ...DEFAULT_SETTINGS,
    checkForUpdates: true,
  });
  const { runApplication } = await import("../../../src/main/wiring/application");
  const wiring = runApplication();
  await vi.waitFor(() => {
    expect(updateMock.getRelease).toHaveBeenCalled();
  });
  expect(updateMock.getRelease).toHaveBeenCalledWith(
    "0.1.0",
    "linux",
    "https://api.github.com/repos/scott-r-lindsey/foom/releases/latest",
    expect.any(AbortSignal),
  );
  const setupDeps = mock.setup.deps as { updates(): unknown; restartToUpdate(): Promise<void> };
  expect(setupDeps.updates()).toEqual({ status: "idle", runningAgents: 0 });
  await setupDeps.restartToUpdate();
  expect(mock.quit).not.toHaveBeenCalled();
  wiring.updates.dispose();
});
