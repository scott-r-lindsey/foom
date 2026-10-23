import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { newerStable, Updates } from "../../../src/main/updates";
import type { UpdateDependencies } from "../../../src/main/updates";

const active: Updates[] = [];
afterEach(() => {
  for (const updates of active) updates.dispose();
  active.length = 0;
  vi.useRealTimers();
});
function fixture(
  overrides: Partial<
    Pick<UpdateDependencies, "packaged" | "version" | "platform" | "arch" | "nightlyDate">
  > = {},
) {
  const updater = Object.assign(new EventEmitter(), {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  });
  const deps = {
    packaged: true,
    version: "0.1.0",
    platform: "darwin",
    arch: "arm64",
    updater,
    getRelease: vi
      .fn<UpdateDependencies["getRelease"]>()
      .mockResolvedValue({ draft: false, prerelease: false, tag_name: "v0.2.0" }),
    changed: vi.fn(),
    requestQuit: vi.fn(async () => {}),
    ...overrides,
  };
  const updates = new Updates(deps);
  active.push(updates);
  return { updates, deps, updater };
}

test("stable macOS stages silently; explicit restart only relaunches behind the normal quit barrier", async () => {
  const { updates, deps, updater } = fixture();
  updates.configure(true);
  expect(updater.setFeedURL).toHaveBeenCalledWith({
    url: "https://update.electronjs.org/scott-r-lindsey/foom/darwin-arm64/0.1.0",
  });
  await updates.restartToUpdate();
  expect(deps.requestQuit).not.toHaveBeenCalled();
  updater.emit("update-downloaded");
  expect(updates.state(3)).toEqual({ status: "downloaded", runningAgents: 3 });
  await updates.check();
  expect(updater.checkForUpdates).toHaveBeenCalledOnce();
  updates.quitting(); // Ordinary quit uses Squirrel's native install-on-exit; no relaunch.
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  expect(deps.requestQuit).not.toHaveBeenCalled();
  deps.requestQuit.mockImplementation(() => {
    updates.quitting();
    return Promise.resolve();
  });
  await updates.restartToUpdate();
  expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  expect(deps.getRelease).not.toHaveBeenCalled();
});

test("cancelled or failed quit cannot relaunch, and duplicate restart requests share the quit", async () => {
  const { updates, deps, updater } = fixture();
  updates.configure(true);
  updater.emit("update-downloaded");
  let finish: () => void = () => {};
  deps.requestQuit.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = updates.restartToUpdate();
  await updates.restartToUpdate();
  expect(deps.requestQuit).toHaveBeenCalledOnce();
  finish();
  await pending;
  updates.quitting();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  deps.requestQuit.mockRejectedValueOnce(new Error("shutdown failed"));
  await expect(updates.restartToUpdate()).rejects.toThrow("shutdown failed");
  updates.quitting();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
});

test("opt-out, development and stable Windows never check or restart", async () => {
  for (const options of [{}, { packaged: false }, { platform: "win32" }, { platform: "freebsd" }]) {
    const { updates, deps, updater } = fixture(options);
    updates.configure(false);
    await updates.check();
    await updates.restartToUpdate();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(deps.getRelease).not.toHaveBeenCalled();
    if (Object.keys(options).length) {
      updates.configure(true);
      await updates.check();
      expect(updater.checkForUpdates).not.toHaveBeenCalled();
      expect(deps.getRelease).not.toHaveBeenCalled();
    }
  }
});

test("off switch stops retries and ignores late native events; errors use fixed local status", async () => {
  vi.useFakeTimers();
  const { updates, updater } = fixture();
  updates.configure(true);
  updater.emit("error", new Error("secret remote text"));
  expect(updates.state(0).status).toBe("error");
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  updater.emit("update-not-available");
  expect(updates.state(0).status).toBe("idle");
  updates.configure(false);
  updater.emit("update-downloaded");
  updater.emit("error");
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
  await updates.restartToUpdate();
  updates.quitting();
  expect(updates.state(0).status).toBe("idle");
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  updates.configure(true);
  updater.checkForUpdates.mockImplementationOnce(() => {
    throw new Error("failed");
  });
  updater.emit("update-not-available");
  await updates.check();
  expect(updates.state(0).status).toBe("error");
});

test("Linux uses anonymous stable release metadata and never installs or restarts", async () => {
  const { updates, deps, updater } = fixture({ platform: "linux" });
  updates.configure(true);
  await vi.waitFor(() => {
    expect(updates.state(0).status).toBe("available");
  });
  expect(deps.getRelease).toHaveBeenCalledWith(
    "https://api.github.com/repos/scott-r-lindsey/foom/releases/latest",
    expect.any(AbortSignal),
  );
  await updates.check();
  await updates.restartToUpdate();
  updates.quitting();
  expect(deps.getRelease).toHaveBeenCalledOnce();
  expect(updater.checkForUpdates).not.toHaveBeenCalled();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
});

const nightly = (version: string) => ({
  draft: false,
  prerelease: true,
  tag_name: "nightly",
  body: `Commit: ${"a".repeat(40)}\nCommit date: 2026-10-23T01:00:00Z\nVersion: ${version}\n`,
});
test.each(["darwin", "linux", "win32"])(
  "%s nightly is notice only, with no native updater",
  async (platform) => {
    const { updates, deps, updater } = fixture({
      platform,
      version: "0.1.0-nightly.20261022+bbbbbbb",
    });
    deps.getRelease.mockResolvedValue(nightly("0.1.0-nightly.20261023+aaaaaaa"));
    updates.configure(true);
    await vi.waitFor(() => {
      expect(updates.state(0).status).toBe("available");
    });
    expect(deps.getRelease).toHaveBeenCalledWith(
      "https://api.github.com/repos/scott-r-lindsey/foom/releases/tags/nightly",
      expect.any(AbortSignal),
    );
    await updates.restartToUpdate();
    updates.quitting();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  },
);

test.each(["0.1.0-nightly.20261022+bbbbbbb", "0.1.0-nightly.20261021+aaaaaaa"])(
  "same or older nightly %s stays quiet",
  async (version) => {
    const { updates, deps } = fixture({
      platform: "linux",
      version: "0.1.0-nightly.20261022+bbbbbbb",
    });
    deps.getRelease.mockResolvedValue(nightly(version));
    updates.configure(true);
    await vi.waitFor(() => {
      expect(deps.getRelease).toHaveResolved();
    });
    expect(updates.state(0).status).toBe("idle");
  },
);

test.each([{}, { draft: true }, { draft: false, prerelease: true, tag_name: "v3.0.0" }])(
  "untrusted stable release metadata %j fails quietly",
  async (release) => {
    const { updates, deps } = fixture({ platform: "linux" });
    deps.getRelease.mockResolvedValue(release);
    updates.configure(true);
    await vi.waitFor(() => {
      expect(updates.state(0).status).toBe("error");
    });
  },
);

test.each([{ draft: false, prerelease: false, tag_name: "nightly" }, nightly("invalid")])(
  "invalid nightly metadata fails quietly",
  async (release) => {
    const { updates, deps } = fixture({ version: "0.1.0-nightly.20261022+bbbbbbb" });
    deps.getRelease.mockResolvedValue(release);
    updates.configure(true);
    await vi.waitFor(() => {
      expect(updates.state(0).status).toBe("error");
    });
  },
);

test("opt-out aborts pending HTTP and invalidates its result after re-enable", async () => {
  const { updates, deps } = fixture({ platform: "linux" });
  let resolve: (value: unknown) => void = () => {};
  deps.getRelease.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  updates.configure(true);
  await updates.check();
  const signal = deps.getRelease.mock.calls[0]?.[1];
  updates.configure(false);
  expect(signal?.aborted).toBe(true);
  updates.configure(true);
  resolve({ draft: false, prerelease: false, tag_name: "v9.0.0" });
  await vi.waitFor(() => {
    expect(updates.state(0).status).toBe("available");
  });
  updates.configure(false);
  deps.getRelease.mockRejectedValue(new Error("remote secret"));
  updates.configure(true);
  await vi.waitFor(() => {
    expect(updates.state(0).status).toBe("error");
  });
});

test.each([
  ["v1.0.0", "0.9.9", true],
  ["0.2.0", "0.1.9", true],
  ["0.1.1", "0.1.0", true],
  ["0.1.0", "0.1.0", false],
  ["0.1.0", "1.0.0", false],
  ["invalid", "0.1.0", false],
  ["1.0.0", "invalid", false],
])("compares stable %s to %s", (candidate, current, expected) => {
  expect(newerStable(candidate, current)).toBe(expected);
});

test("no published release is a quiet success", async () => {
  const { updates, deps } = fixture({ platform: "linux" });
  deps.getRelease.mockResolvedValue(null);
  updates.configure(true);
  await vi.waitFor(() => {
    expect(deps.getRelease).toHaveResolved();
  });
  expect(updates.state(0).status).toBe("idle");
});

test.each([
  ["2026-10-23T00:00:00Z", "available"],
  ["2026-10-23T02:00:00Z", "idle"],
  [undefined, "idle"],
])("same-day nightly uses commit timestamp %s", async (nightlyDate, status) => {
  const { updates, deps } = fixture({ version: "0.1.0-nightly.20261023+bbbbbbb", nightlyDate });
  deps.getRelease.mockResolvedValue(nightly("0.1.0-nightly.20261023+aaaaaaa"));
  updates.configure(true);
  await vi.waitFor(() => {
    expect(deps.getRelease).toHaveResolved();
  });
  expect(updates.state(0).status).toBe(status);
});

test("an explicit native installation failure falls back to ordinary quit", async () => {
  const { updates, deps, updater } = fixture();
  updates.configure(true);
  updater.emit("update-downloaded");
  updater.quitAndInstall.mockImplementation(() => {
    throw new Error("failed native install");
  });
  deps.requestQuit.mockImplementation(() => {
    expect(updates.quitting()).toBe(false);
    return Promise.resolve();
  });
  await updates.restartToUpdate();
  expect(updates.state(0).status).toBe("error");
});

test("late native errors during exit remain handled after disposal", () => {
  const { updates, updater } = fixture();
  updates.configure(true);
  updates.dispose();
  expect(() => updater.emit("error", new Error("late download failure"))).not.toThrow();
  expect(updates.state(0).status).toBe("idle");
});
