import { expect, test, vi } from "vitest";
import { basename, dirname, resolve } from "node:path";
import { handleInstaller } from "../../../src/main/installer";

test("installer callbacks are limited to packaged Windows and known lifecycle arguments", () => {
  for (const platform of ["darwin", "linux", "win32"] as const)
    for (const isPackaged of [false, true]) {
      const app = { isPackaged, quit: vi.fn() };
      const execute = vi.fn<NonNullable<Parameters<typeof handleInstaller>[4]>>();
      for (const event of [undefined, "--squirrel-firstrun", "--unknown"]) {
        expect(
          handleInstaller(app, platform, event ? ["Foom", event] : [], "Foom.exe", execute),
        ).toBe(false);
      }
      const handled = handleInstaller(
        app,
        platform,
        ["Foom", "--squirrel-obsolete"],
        "Foom.exe",
        execute,
      );
      expect(handled).toBe(platform === "win32" && isPackaged);
      expect(app.quit).toHaveBeenCalledTimes(handled ? 1 : 0);
      expect(execute).not.toHaveBeenCalled();
    }
});

test.each(["--squirrel-install", "--squirrel-updated", "--squirrel-uninstall"])(
  "%s uses fixed shortcut arguments and quits even if the helper fails",
  (event) => {
    const app = { isPackaged: true, quit: vi.fn() };
    const execute = vi.fn<NonNullable<Parameters<typeof handleInstaller>[4]>>();
    const executable = resolve("fixture app/app-0.1.0/Foom.exe");
    expect(handleInstaller(app, "win32", ["Foom", event], executable, execute)).toBe(true);
    expect(app.quit).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      resolve(dirname(executable), "..", "Update.exe"),
      [
        event === "--squirrel-uninstall" ? "--removeShortcut" : "--createShortcut",
        basename(executable),
      ],
      { windowsHide: true, timeout: 10000 },
      expect.any(Function),
    );
    execute.mock.calls[0]?.[3]?.(new Error("fixture failure"));
    expect(app.quit).toHaveBeenCalledOnce();
  },
);
