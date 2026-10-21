import { expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ installer: vi.fn(), run: vi.fn() }));
vi.mock("electron", () => ({ app: {} }));
vi.mock("../../../src/main/installer", () => ({ handleInstaller: mocks.installer }));
vi.mock("../../../src/main/wiring/application", () => ({ runApplication: mocks.run }));
test.each([false, true])(
  "main starts the application only outside installer callbacks (%s)",
  async (handled) => {
    vi.resetModules();
    mocks.run.mockClear();
    mocks.installer.mockReturnValue(handled);
    await import("../../../src/main/main");
    expect(mocks.run).toHaveBeenCalledTimes(handled ? 0 : 1);
  },
);
