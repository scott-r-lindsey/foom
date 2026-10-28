import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { newerStable, Updates } from "../../../src/main/updates";
import type { UpdateDependencies } from "../../../src/main/updates";

const active: Updates[] = [];
const archive =
  "https://github.com/scott-r-lindsey/foom/releases/download/v0.2.0/Foom-darwin-arm64-0.2.0.zip";
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
  const local = { url: "file:///test/feed.json", dispose: vi.fn(async () => {}) };
  const deps = {
    packaged: true,
    version: "0.1.0",
    platform: "darwin",
    arch: "arm64",
    updater,
    activityFlags: vi.fn(() => Promise.resolve("?d=1&w=1&m=1")),
    getRelease: vi
      .fn<UpdateDependencies["getRelease"]>()
      .mockResolvedValue({ draft: false, prerelease: false, tag_name: "v0.2.0" }),
    prepareUpdate: vi.fn<UpdateDependencies["prepareUpdate"]>().mockResolvedValue(local),
    quit: vi.fn(),
    exit: vi.fn(),
    changed: vi.fn(),
    requestQuit: vi.fn(async () => {}),
    ...overrides,
  };
  if (deps.platform === "darwin")
    deps.getRelease.mockResolvedValue(
      deps.version.includes("nightly")
        ? nightly("0.1.0-nightly.20261023+aaaaaaa", "darwin", "arm64")
        : { url: archive },
    );
  const updates = new Updates(deps);
  active.push(updates);
  return { updates, deps, updater, local };
}

test("stable macOS stages silently; explicit restart only relaunches behind the normal quit barrier", async () => {
  const { updates, deps, updater } = fixture();
  updates.configure(true);
  await vi.waitFor(() => {
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      url: "file:///test/feed.json",
      serverType: "json",
    });
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
  expect(deps.getRelease).toHaveBeenCalledOnce();
});

test.each(["0.1.0", "0.1.0-nightly.20261022+bbbbbbb"])(
  "cancelled or failed quit cannot relaunch, and duplicate restart requests share the quit (%s)",
  async (version) => {
    const { updates, deps, updater } = fixture({ version });
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
  },
);

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

test.each(["0.1.0", "0.1.0-nightly.20261022+bbbbbbb"])(
  "off switch stops retries and ignores late native events; errors use fixed local status (%s)",
  async (version) => {
    vi.useFakeTimers();
    const { updates, updater } = fixture({ version });
    updates.configure(true);
    await vi.advanceTimersByTimeAsync(0);
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
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.state(0).status).toBe("error");
  },
);

test("Linux uses anonymous stable release metadata and never installs or restarts", async () => {
  const { updates, deps, updater } = fixture({ platform: "linux" });
  updates.configure(true);
  await vi.waitFor(() => {
    expect(updates.state(0).status).toBe("available");
  });
  expect(deps.getRelease).toHaveBeenCalledWith(
    "https://foom-term.com/u/v1/stable/linux/arm64/0.1.0?d=1&w=1&m=1",
    expect.any(AbortSignal),
  );
  await updates.check();
  await updates.restartToUpdate();
  updates.quitting();
  expect(deps.getRelease).toHaveBeenCalledOnce();
  expect(updater.checkForUpdates).not.toHaveBeenCalled();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
});

const nightly = (version: string, platform = "linux", arch = "x64") => {
  const day = /nightly\.(\d{8})/.exec(version)?.[1] ?? "invalid";
  const short = version.split("+")[1] ?? "invalid";
  const commit = short.padEnd(40, short[0]);
  return {
    version,
    commit,
    commitDate: `2026-10-${day.slice(6)}T01:00:00Z`,
    sha256: "a".repeat(64),
    url: `https://foom-term.com/updates/nightly/artifacts/${commit}/Foom-nightly-${day}-${short}-${platform}-${arch}.zip`,
  };
};
test.each(["linux", "win32"])(
  "%s nightly uses site notices only, with no native updater",
  async (platform) => {
    const { updates, deps, updater } = fixture({
      platform,
      arch: "x64",
      version: "0.1.0-nightly.20261022+bbbbbbb",
    });
    deps.getRelease.mockResolvedValue(nightly("0.1.0-nightly.20261023+aaaaaaa", platform));
    updates.configure(true);
    await vi.waitFor(() => {
      expect(updates.state(0).status).toBe("available");
    });
    expect(deps.getRelease).toHaveBeenCalledWith(
      `https://foom-term.com/u/v1/nightly/${platform}/x64/0.1.0-nightly.20261022%2Bbbbbbbb?d=1&w=1&m=1`,
      expect.any(AbortSignal),
    );
    await updates.restartToUpdate();
    updates.quitting();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  },
);

test("macOS nightly stages an immutable archive and only restarts through the normal quit barrier", async () => {
  const { updates, deps, updater } = fixture({ version: "0.1.0-nightly.20261022+bbbbbbb" });
  const metadata = nightly("0.1.0-nightly.20261023+aaaaaaa", "darwin", "arm64");
  deps.getRelease.mockResolvedValue(metadata);
  updates.configure(true);
  await vi.waitFor(() => {
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
  });
  expect(deps.getRelease).toHaveBeenCalledWith(
    "https://foom-term.com/u/v1/nightly/darwin/arm64/0.1.0-nightly.20261022%2Bbbbbbbb?d=1&w=1&m=1",
    expect.any(AbortSignal),
  );
  expect(deps.prepareUpdate).toHaveBeenCalledWith(
    {
      version: metadata.version,
      url: metadata.url,
      sha256: metadata.sha256,
      commitDate: metadata.commitDate,
      bundleVersion: "20261023.3600.0",
    },
    expect.any(AbortSignal),
  );
  updater.emit("update-downloaded");
  expect(updates.state(4)).toEqual({ status: "downloaded", runningAgents: 4 });
  expect(updates.quitting()).toBe(false);
  expect(deps.requestQuit).not.toHaveBeenCalled();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  deps.requestQuit.mockImplementation(() => {
    updates.quitting();
    return Promise.resolve();
  });
  await updates.restartToUpdate();
  expect(updater.quitAndInstall).toHaveBeenCalledOnce();
});

test.each(["0.1.0-nightly.20261022+bbbbbbb", "0.1.0-nightly.20261021+aaaaaaa"])(
  "same or older nightly %s stays quiet",
  async (version) => {
    const { updates, deps } = fixture({
      platform: "linux",
      arch: "x64",
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
  const { updates, deps } = fixture({
    platform: "linux",
    arch: "x64",
    version: "0.1.0-nightly.20261023+bbbbbbb",
    nightlyDate,
  });
  deps.getRelease.mockResolvedValue(nightly("0.1.0-nightly.20261023+aaaaaaa"));
  updates.configure(true);
  await vi.waitFor(() => {
    expect(deps.getRelease).toHaveResolved();
  });
  expect(updates.state(0).status).toBe(status);
});

test("late native errors during exit remain handled after disposal", () => {
  const { updates, updater } = fixture();
  updates.configure(true);
  updates.dispose();
  expect(() => updater.emit("error", new Error("late download failure"))).not.toThrow();
  expect(updates.state(0).status).toBe("idle");
});

test.each(["0.1.0", "0.0.9"])(
  "native path rejects equal/older %s before archive download",
  async (version) => {
    const { updates, deps, updater } = fixture();
    deps.getRelease.mockResolvedValue({ url: archive.replaceAll("0.2.0", version) });
    updates.configure(true);
    await vi.waitFor(() => {
      expect(deps.getRelease).toHaveResolved();
    });
    expect(updates.state(0).status).toBe("idle");
    expect(deps.prepareUpdate).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  },
);

test.each(["0.1.0", "0.1.0-nightly.20261022+bbbbbbb"])(
  "opting out during native metadata prevents both ZIP and native work, even after re-enable (%s)",
  async (version) => {
    const { updates, deps, updater } = fixture({ version });
    let complete: (value: unknown) => void = () => {};
    deps.getRelease.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    updates.configure(true);
    await Promise.resolve();
    const signal = deps.getRelease.mock.calls[0]?.[1];
    updates.configure(false);
    expect(signal?.aborted).toBe(true);
    complete({ url: archive });
    await Promise.resolve();
    expect(deps.prepareUpdate).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    updates.configure(true);
    await vi.waitFor(() => {
      expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    });
  },
);

test.each(["0.1.0", "0.1.0-nightly.20261022+bbbbbbb"])(
  "opting out during the ZIP download aborts it and disposes a stale completed feed (%s)",
  async (version) => {
    const { updates, deps, updater, local } = fixture({ version });
    let complete: (value: typeof local) => void = () => {};
    deps.prepareUpdate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    updates.configure(true);
    await vi.waitFor(() => {
      expect(deps.prepareUpdate).toHaveBeenCalledOnce();
    });
    const signal = deps.prepareUpdate.mock.calls[0]?.[1];
    updates.configure(false);
    expect(signal?.aborted).toBe(true);
    complete(local);
    await vi.waitFor(() => {
      expect(local.dispose).toHaveBeenCalledOnce();
    });
    expect(updater.setFeedURL).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  },
);

test.each(["0.1.0", "0.1.0-nightly.20261022+bbbbbbb"])(
  "last opt-out guard runs immediately before the native check (%s)",
  async (version) => {
    const { updates, updater } = fixture({ version });
    updater.setFeedURL.mockImplementationOnce(() => {
      updates.configure(false);
    });
    updates.configure(true);
    await vi.waitFor(() => {
      expect(updater.setFeedURL).toHaveBeenCalledOnce();
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  },
);

test.each(["throw", "error", "stall", "quit throws"])(
  "native restart %s has a bounded shutdown fallback after disposal",
  async (failure) => {
    vi.useFakeTimers();
    const { updates, deps, updater } = fixture();
    updates.configure(true);
    await vi.advanceTimersByTimeAsync(0);
    updater.emit("update-downloaded");
    if (failure === "throw")
      updater.quitAndInstall.mockImplementationOnce(() => {
        throw new Error("native failed");
      });
    if (failure === "quit throws")
      deps.quit.mockImplementationOnce(() => {
        throw new Error("quit failed");
      });
    deps.requestQuit.mockImplementation(() => {
      expect(updates.quitting()).toBe(true);
      updates.dispose();
      return Promise.resolve();
    });
    await updates.restartToUpdate();
    if (failure === "error") {
      updater.emit("error");
      updater.emit("error");
    }
    if (failure === "stall" || failure === "quit throws") {
      expect(deps.quit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(deps.quit).toHaveBeenCalledOnce();
    expect(deps.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.exit).toHaveBeenCalledOnce();
  },
);

test("a hostile macOS feed never reaches ZIP preparation or native code", async () => {
  const { updates, deps, updater } = fixture();
  deps.getRelease.mockResolvedValue({ url: "https://evil.example/update.zip", version: "99.0.0" });
  updates.configure(true);
  await vi.waitFor(() => {
    expect(updates.state(0).status).toBe("error");
  });
  expect(deps.prepareUpdate).not.toHaveBeenCalled();
  expect(updater.setFeedURL).not.toHaveBeenCalled();
  expect(updater.checkForUpdates).not.toHaveBeenCalled();
});

test.each(["0.2.0", "0.0.9-nightly.20261024+aaaaaaa", "0.1.0-nightly.20261021+aaaaaaa"])(
  "macOS nightly never stages cross-channel or older version %s",
  async (version) => {
    const { updates, deps, updater } = fixture({ version: "0.1.0-nightly.20261022+bbbbbbb" });
    deps.getRelease.mockResolvedValue(
      version.includes("nightly") ? nightly(version, "darwin", "arm64") : { url: archive, version },
    );
    updates.configure(true);
    await vi.waitFor(() => {
      expect(deps.getRelease).toHaveResolved();
    });
    expect(deps.prepareUpdate).not.toHaveBeenCalled();
    expect(updater.setFeedURL).not.toHaveBeenCalled();
  },
);

test.each([
  ["darwin", "0.1.0", "https://update.electronjs.org/scott-r-lindsey/foom/darwin-arm64/0.1.0"],
  ["linux", "0.1.0", "https://api.github.com/repos/scott-r-lindsey/foom/releases/latest"],
  [
    "darwin",
    "0.1.0-nightly.20261022+bbbbbbb",
    "https://foom-term.com/updates/nightly/darwin-arm64/latest-mac.json",
  ],
  [
    "linux",
    "0.1.0-nightly.20261022+bbbbbbb",
    "https://foom-term.com/updates/nightly/linux-arm64/latest.json",
  ],
  [
    "win32",
    "0.1.0-nightly.20261022+bbbbbbb",
    "https://foom-term.com/updates/nightly/win32-arm64/latest.json",
  ],
])("%s %s falls back to the unchanged channel source", async (platform, version, fallback) => {
  const { updates, deps } = fixture({ platform, version });
  deps.getRelease.mockRejectedValueOnce(new Error("network failed")).mockResolvedValueOnce(null);
  updates.configure(true);
  await vi.waitFor(() => {
    expect(deps.getRelease).toHaveBeenCalledTimes(2);
  });
  const channel = version.includes("nightly") ? "nightly" : "stable";
  expect(deps.getRelease.mock.calls[0]?.[0]).toBe(
    `https://foom-term.com/u/v1/${channel}/${platform}/arm64/${encodeURIComponent(version)}?d=1&w=1&m=1`,
  );
  expect(deps.getRelease.mock.calls[1]).toEqual([fallback, deps.getRelease.mock.calls[0]?.[1]]);
  expect(updates.state(0).status).toBe("idle");
  expect(deps.activityFlags).toHaveBeenCalledOnce();
});

test("opt-out during proxy failure prevents fallback, even after re-enable", async () => {
  const { updates, deps } = fixture({ platform: "linux" });
  let fail: (error: Error) => void = () => {};
  deps.getRelease.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  updates.configure(true);
  await Promise.resolve();
  updates.configure(false);
  updates.configure(true);
  fail(new Error("timeout"));
  await vi.waitFor(() => {
    expect(updates.state(0).status).toBe("available");
  });
  expect(deps.getRelease).toHaveBeenCalledTimes(2);
  expect(
    deps.getRelease.mock.calls.every(([url]) => url.startsWith("https://foom-term.com/u/v1/")),
  ).toBe(true);
});

test("opt-out during activity persistence prevents any request", async () => {
  const { updates, deps } = fixture();
  let finish: (flags: string) => void = () => {};
  deps.activityFlags.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  updates.configure(true);
  updates.configure(false);
  finish("?d=1");
  await Promise.resolve();
  expect(deps.getRelease).not.toHaveBeenCalled();
});

test.each(["network failure", "timeout", "HTTP 404", "HTTP 503", "redirect"])(
  "proxy %s falls back once and upstream failure uses fixed status",
  async (failure) => {
    const { updates, deps } = fixture({ platform: "linux" });
    deps.getRelease.mockRejectedValue(new Error(failure));
    updates.configure(true);
    await vi.waitFor(() => {
      expect(updates.state(0).status).toBe("error");
    });
    expect(deps.getRelease.mock.calls.map(([url]) => url)).toEqual([
      "https://foom-term.com/u/v1/stable/linux/arm64/0.1.0?d=1&w=1&m=1",
      "https://api.github.com/repos/scott-r-lindsey/foom/releases/latest",
    ]);
  },
);

test("opt-out aborts pending fallback and stops future checks", async () => {
  const { updates, deps } = fixture({ platform: "linux" });
  let finish: (value: unknown) => void = () => {};
  deps.getRelease.mockRejectedValueOnce(new Error("offline")).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  updates.configure(true);
  await vi.waitFor(() => {
    expect(deps.getRelease).toHaveBeenCalledTimes(2);
  });
  updates.configure(false);
  expect(deps.getRelease.mock.calls[1]?.[1].aborted).toBe(true);
  finish({ draft: false, prerelease: false, tag_name: "v9.0.0" });
  await updates.check();
  expect(updates.state(0).status).toBe("idle");
  expect(deps.getRelease).toHaveBeenCalledTimes(2);
});
