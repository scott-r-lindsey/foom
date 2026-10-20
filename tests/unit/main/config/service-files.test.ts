import { readdir, rename } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { fixture, palette, theme } from "./service-fixture";

for (const code of ["EPERM", "EBUSY"]) {
  test(`Windows config restore retries transient ${code} without applying early`, async () => {
    const replace = vi.fn(rename);
    const f = await fixture({ platform: "win32", rename: replace });
    await f.service.initialize();
    const original = theme("Personal");
    const proposed = theme("Personal", { ...palette.colors, ink: "#ffb23e" });
    await f.write("themes/personal.json", original);
    await f.service.refresh();
    await f.service.write({ interfaceTheme: "user:personal.json" });
    await f.write("themes/personal.json", proposed);
    await f.service.refresh();
    const pending = f.service.status().pending;
    const baseline = f.themeBaselines.get("themes/personal.json");
    replace.mockClear();
    replace.mockImplementationOnce(async () => {
      expect(await f.read("themes/personal.json")).toBe(proposed);
      expect(f.service.status().pending).toEqual(pending);
      expect(f.themeBaselines.get("themes/personal.json")).toBe(baseline);
      throw Object.assign(new Error("sharing violation"), { code });
    });
    await f.decide("keep");
    expect(replace).toHaveBeenCalledTimes(2);
    expect(await f.read("themes/personal.json")).toBe(original);
    expect(f.service.status().pending).toBeNull();
    expect(
      (await readdir(path.join(f.folder, "themes"))).filter((name) => name.startsWith(".foom-")),
    ).toEqual([]);
  });
}

for (const [platform, code, attempts] of [
  ["win32", "EPERM", 5],
  ["win32", "EBUSY", 5],
  ["win32", "EACCES", 1],
  ["linux", "EPERM", 1],
  ["darwin", "EBUSY", 1],
] as const) {
  test(`${platform} failed config restore (${code}) preserves file and approval`, async () => {
    const replace = vi.fn(rename);
    const f = await fixture({ platform, rename: replace });
    await f.service.initialize();
    const original = await f.read("settings.json");
    await f.settings({ hooks: false });
    await f.service.refresh();
    const proposed = await f.read("settings.json");
    const status = f.service.status();
    const baseline = f.baseline();
    const applied = [...f.applied];
    replace.mockClear();
    replace.mockRejectedValue(Object.assign(new Error("sharing violation"), { code }));
    await expect(f.decide("keep")).rejects.toThrow(
      "Unable to replace settings.json. The change was not applied.",
    );
    expect(replace).toHaveBeenCalledTimes(attempts);
    expect(await f.read("settings.json")).toBe(proposed);
    expect(f.service.status()).toEqual(status);
    expect(f.baseline()).toBe(baseline);
    expect(f.applied).toEqual(applied);
    expect((await readdir(f.folder)).filter((name) => name.startsWith(".foom-"))).toEqual([]);
    replace.mockImplementation(rename);
    await f.decide("keep");
    expect(await f.read("settings.json")).toBe(original);
  });
}

test("persistent Windows theme lock preserves the held palette and can be decided later", async () => {
  const replace = vi.fn(rename);
  const f = await fixture({ platform: "win32", rename: replace });
  await f.service.initialize();
  const original = theme("Personal");
  const proposed = theme("Personal", { ...palette.colors, ink: "#ffb23e" });
  await f.write("themes/personal.json", original);
  await f.service.refresh();
  await f.service.write({ interfaceTheme: "user:personal.json" });
  await f.write("themes/personal.json", proposed);
  await f.service.refresh();
  const status = f.service.status();
  const baseline = f.themeBaselines.get("themes/personal.json");
  replace.mockClear();
  replace.mockRejectedValue(Object.assign(new Error("locked"), { code: "EPERM" }));
  await expect(f.decide("keep")).rejects.toThrow(
    "Unable to replace themes/personal.json. The change was not applied.",
  );
  expect(replace).toHaveBeenCalledTimes(5);
  expect(await f.read("themes/personal.json")).toBe(proposed);
  expect(f.service.status()).toEqual(status);
  expect(f.themeBaselines.get("themes/personal.json")).toBe(baseline);
  expect(
    (await readdir(path.join(f.folder, "themes"))).filter((name) => name.startsWith(".foom-")),
  ).toEqual([]);
  replace.mockImplementation(rename);
  await f.decide("keep");
  expect(await f.read("themes/personal.json")).toBe(original);
});

test("failed Settings save leaves the held proposal and its event unchanged", async () => {
  const replace = vi.fn(rename);
  const f = await fixture({ platform: "win32", rename: replace });
  await f.service.initialize();
  await f.settings({ hooks: false });
  await f.service.refresh();
  const status = f.service.status();
  const proposed = await f.read("settings.json");
  const applied = [...f.applied];
  replace.mockRejectedValue(new Error("disk unavailable"));
  await expect(f.service.write({ terminalFontSize: 20 })).rejects.toThrow(
    "The change was not applied.",
  );
  expect(await f.read("settings.json")).toBe(proposed);
  expect(f.service.status()).toEqual(status);
  expect(f.applied).toEqual(applied);
});
