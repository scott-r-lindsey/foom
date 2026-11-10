import { afterEach, expect, test, vi } from "vitest";
import { GithubSignIn } from "../../../../src/main/setup/github-sign-in";
const tick = async () => {
  await vi.advanceTimersByTimeAsync(0);
};
function fixture(lines = ["! First copy your one-time code: ABCD-1234"]) {
  vi.useFakeTimers();
  let clipboard = "previous";
  const listeners = new Set<() => void>();
  const effects = {
    observe: vi.fn((_id: string, listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    output: () => {
      for (const listener of listeners) listener();
    },
    screen: vi.fn(() => Promise.resolve({ lines })),
    copy: vi.fn<(value: string) => void | Promise<void>>((value) => {
      clipboard = value;
    }),
    clipboard: vi.fn(() => clipboard),
    clear: vi.fn(() => {
      clipboard = "";
    }),
    open: vi.fn(async () => {}),
    stop: vi.fn(async (_id: string) => {}),
  };
  const service = new GithubSignIn(effects);
  return {
    service,
    effects,
    clipboard: () => clipboard,
    setClipboard: (value: string) => {
      clipboard = value;
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
});
test("only explicitly started IDs can copy a strict recipe code or open the fixed destination", async () => {
  const { service, effects, clipboard } = fixture();
  for (const id of [null, "foreign", {}, 3])
    await expect(service.action(id, "open")).rejects.toThrow();
  service.start("gh");
  service.start("gh");
  await tick();
  expect(await service.action("gh", "read")).toEqual({
    phase: "waiting",
    code: "ABCD-1234",
    copied: true,
    opened: true,
  });
  expect(clipboard()).toBe("ABCD-1234");
  expect(effects.open).toHaveBeenCalledTimes(1);
  effects.output();
  effects.output();
  await tick();
  expect(effects.open).toHaveBeenCalledTimes(1);
  await service.action("gh", "copy");
  await service.action("gh", "open");
  expect(effects.copy).toHaveBeenCalledTimes(2);
  expect(effects.open).toHaveBeenCalledTimes(2);
  for (const action of [null, {}, "url", "https://evil.test/"])
    await expect(service.action("gh", action)).rejects.toThrow();
  effects.screen.mockResolvedValue({ lines: ["✓ Authentication complete."] });
  effects.output();
  await tick();
  expect((await service.action("gh", "read")).phase).toBe("finishing");
  await service.finish("gh", 0);
  expect(await service.action("gh", "read")).toEqual({
    phase: "done",
    code: undefined,
    copied: true,
    opened: true,
    exitCode: 0,
  });
  expect(clipboard()).toBe("");
  await service.action("gh", "copy");
  await service.action("gh", "open");
  expect(effects.open).toHaveBeenCalledTimes(2);
  service.dispose();
});
test.each([
  "ABCD-12345",
  "ABCD-123",
  "abcd-1234",
  "ABCD\u202e-1234",
  "https://evil.test/ABCD-1234",
  "ABCD-1234;evil",
])("untrusted code %s grants no effects", async (value) => {
  const { service, effects } = fixture([`! First copy your one-time code: ${value}`]);
  service.start("gh");
  await tick();
  expect(effects.copy).not.toHaveBeenCalled();
  expect(effects.open).not.toHaveBeenCalled();
  expect((await service.action("gh", "read")).phase).toBe("starting");
  service.dispose();
});
test("blocked effects leave independent retry buttons and never erase a changed clipboard", async () => {
  const { service, effects } = fixture();
  effects.copy.mockImplementationOnce(() => {
    throw new Error("blocked");
  });
  effects.open.mockRejectedValueOnce(new Error("blocked"));
  service.start("gh");
  await tick();
  expect(await service.action("gh", "read")).toMatchObject({ copied: false, opened: false });
  await service.action("gh", "copy");
  await service.action("gh", "open");
  await effects.copy("user text");
  await service.finish("gh", 1);
  expect(effects.clear).not.toHaveBeenCalled();
  expect((await service.action("gh", "read")).phase).toBe("failed");
  service.dispose();
});
test("cancel stops its process; expired output is classified and clipboard failures stay local", async () => {
  const { service, effects } = fixture();
  service.start("gh");
  await tick();
  effects.screen.mockResolvedValue({ lines: ["the device code has expired"] });
  await service.finish("gh", 1);
  expect((await service.action("gh", "read")).phase).toBe("expired");
  service.start("cancel");
  await tick();
  expect((await service.action("cancel", "cancel")).phase).toBe("cancelled");
  expect(effects.stop).toHaveBeenCalledWith("cancel");
  expect(effects.clear).toHaveBeenCalledOnce();
  effects.clipboard.mockImplementation(() => {
    throw new Error("blocked");
  });
  service.start("next");
  await tick();
  await service.finish("next", 1);
  await service.finish("unknown", 0);
  service.dispose();
});
test("disposal or exit revokes a pending screen before it can write or open", async () => {
  const { service, effects } = fixture();
  let resolve = (_value: { lines: string[] }) => {};
  effects.screen.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  service.start("gh");
  service.dispose();
  resolve({ lines: ["! First copy your one-time code: ABCD-1234"] });
  await tick();
  expect(effects.copy).not.toHaveBeenCalled();
  expect(effects.open).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
test("screen failures do not create effects; retry and termination remain available", async () => {
  const { service, effects } = fixture();
  effects.screen.mockRejectedValueOnce(new Error("offline"));
  service.start("gh");
  await tick();
  expect(effects.open).not.toHaveBeenCalled();
  await service.action("gh", "open");
  expect(effects.open).not.toHaveBeenCalled();
  effects.output();
  await tick();
  effects.copy.mockImplementation(() => {
    throw new Error("blocked");
  });
  effects.open.mockRejectedValue(new Error("blocked"));
  expect(await service.action("gh", "copy")).toMatchObject({ copied: false });
  expect(await service.action("gh", "open")).toMatchObject({ opened: false });
  service.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

test("host clipboard success format is parsed without using the remote URL", async () => {
  const { service, effects } = fixture([
    "! One-time code (ABCD-1234) copied to clipboard",
    "Open this URL: https://evil.test/",
  ]);
  service.start("gh");
  await tick();
  expect(effects.copy).toHaveBeenCalledWith("ABCD-1234");
  expect(effects.open).toHaveBeenCalledOnce();
  service.dispose();
});

test("live capability capacity refuses overflow and retired IDs can be reclaimed", async () => {
  const { service } = fixture([]);
  for (let index = 0; index < 256; index++) service.start(`gh-${String(index)}`);
  expect(() => {
    service.start("overflow");
  }).toThrow("Too many sign-ins");
  await tick();
  await service.finish("gh-0", 0);
  service.start("replacement");
  await expect(service.action("gh-0", "read")).rejects.toThrow("Sign-in unavailable");
  expect((await service.action("replacement", "read")).phase).toBe("starting");
  service.dispose();
  await tick();
  expect(vi.getTimerCount()).toBe(0);
});

test("output notifications coalesce pending reads and stop entirely after exit", async () => {
  const { service, effects } = fixture([]);
  let resolve = (_value: { lines: string[] }) => {};
  effects.screen.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  service.start("gh");
  effects.output();
  effects.output();
  expect(effects.screen).toHaveBeenCalledOnce();
  resolve({ lines: [] });
  await tick();
  expect(effects.screen).toHaveBeenCalledTimes(2);
  await service.finish("gh", 0);
  effects.output();
  await tick();
  expect(effects.screen).toHaveBeenCalledTimes(2);
  service.dispose();
});

test("failed Stop retains the active sign-in and permits a later cancel", async () => {
  const { service, effects } = fixture();
  service.start("gh");
  await tick();
  effects.stop.mockRejectedValueOnce(new Error("offline"));
  await expect(service.action("gh", "cancel")).rejects.toThrow("offline");
  expect((await service.action("gh", "read")).phase).toBe("waiting");
  expect((await service.action("gh", "cancel")).phase).toBe("cancelled");
  service.dispose();
});

test.each(["exit", "dispose"])(
  "%s waits for an in-flight manual clipboard write before clearing its code",
  async (end) => {
    const { service, effects, clipboard, setClipboard } = fixture();
    service.start("gh");
    await tick();
    let release = () => {};
    effects.copy.mockImplementationOnce((value) =>
      new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => {
        setClipboard(value);
      }),
    );
    const copying = service.action("gh", "copy");
    const duplicate = service.action("gh", "copy");
    expect(effects.copy).toHaveBeenCalledTimes(2);
    let ending: Promise<void>;
    if (end === "exit") ending = service.finish("gh", 0);
    else {
      service.dispose();
      ending = Promise.resolve();
    }
    expect(effects.clear).not.toHaveBeenCalled();
    release();
    await copying;
    await duplicate;
    await ending;
    await tick();
    expect(clipboard()).toBe("");
    service.dispose();
  },
);
