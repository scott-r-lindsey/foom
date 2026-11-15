const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { writeFile } = require("node:fs/promises");
const path = require("node:path");
const { deadline, expect } = require("./test-policy.js");
const { launchApp, boardPage, openSettingsScreen } = require("./harness.js");

async function twoBoards(context) {
  const app = await launchApp(context, { fixture: "repository" });
  const writer = await boardPage(app);
  await writer.evaluate(() => window.desktop.appMenu.execute("new-window"));
  let observer;
  await expect
    .poll(() => {
      observer = app
        .windows()
        .find((page) => page !== writer && page.url() === "app://bundle/index.html");
      return Boolean(observer);
    })
    .toBe(true);
  await expect(
    observer.getByRole("button", { name: "Actions for Main checkout", exact: true }),
  ).toBeVisible();
  await openSettingsScreen(observer);
  return { app, writer, observer, nav: observer.getByRole("region", { name: "Settings" }) };
}
for (const [tab, patch, label] of [
  ["General", { showNestedRepositoryNames: true }, "Show repository paths relative to code folder"],
  ["Terminal", { terminalClipboardWrites: true }, "Allow terminal clipboard writes (OSC 52)"],
  ["Agents", { hooks: false }, "Attach hooks"],
]) {
  test(`data views: ${tab} updates an already open Settings window`, {
    timeout: deadline(45_000),
  }, async (context) => {
    const { writer, observer, nav } = await twoBoards(context);
    await nav.getByRole("button", { name: tab, exact: true }).click();
    const control = observer.getByRole("checkbox", { name: label, exact: true });
    await expect(control).toBeVisible();
    const checked = tab !== "Agents";
    await writer.evaluate((patch) => window.desktop.saveSetup(patch), patch);
    if (checked) await expect(control).toBeChecked();
    else await expect(control).not.toBeChecked();
  });
}
test("data views: Appearance and Sound update from another board", {
  timeout: deadline(45_000),
}, async (context) => {
  const { writer, observer, nav } = await twoBoards(context);
  await nav.getByRole("button", { name: "Appearance", exact: true }).click();
  await writer.evaluate(() => window.desktop.saveSetup({ interfaceScale: 110 }));
  await expect(
    observer.getByRole("group", { name: "Interface size" }).locator("output"),
  ).toHaveText("110%");
  await nav.getByRole("button", { name: "Sound", exact: true }).click();
  await writer.evaluate(async () => {
    const { settings } = await window.desktop.setupState();
    await window.desktop.saveSetup({ sound: { ...settings.sound, workingVolume: 0.23 } });
  });
  await expect(observer.getByRole("slider", { name: "Working volume" })).toHaveValue("23");
});
test("data views: Environment changes and masked secrets update another open editor", {
  timeout: deadline(45_000),
}, async (context) => {
  const { writer, observer, nav } = await twoBoards(context);
  await nav.getByRole("button", { name: "Environment", exact: true }).click();
  await writer.evaluate(() =>
    window.desktop.saveEnvironment({
      scope: "all",
      previous: null,
      name: "VIEW_TEST",
      value: "published",
      secret: false,
    }),
  );
  await expect(observer.locator('input[value="VIEW_TEST"]')).toBeVisible();
  await expect(observer.locator('input[value="published"]')).toBeVisible();
  await writer.evaluate(() => window.desktop.removeEnvironment("all", "VIEW_TEST"));
  await expect(observer.locator('input[value="VIEW_TEST"]')).toHaveCount(0);
});
test("data views: config rejection updates open Config and Forges tabs", {
  timeout: deadline(45_000),
}, async (context) => {
  const { writer, observer, nav } = await twoBoards(context);
  const status = await writer.evaluate(() => window.desktop.configStatus());
  await nav.getByRole("button", { name: "Foom config", exact: true }).click();
  await writeFile(path.join(status.folder, "settings.json"), '{"kind":"settings","unknown":true}');
  await expect(observer.getByRole("list", { name: "Rejected files" })).toContainText(
    "settings.json",
  );
  await nav.getByRole("button", { name: "Forges", exact: true }).click();
  await writer.evaluate(() =>
    window.desktop.saveSetup({ forges: { github: false, gitlab: true } }),
  );
  await expect(observer.getByRole("switch", { name: "GitHub", exact: true })).not.toBeChecked();
});
test("data views: repository removal reaches an already open Settings inventory", {
  timeout: deadline(45_000),
}, async (context) => {
  const { writer, observer, nav } = await twoBoards(context);
  const repository = (await writer.evaluate(() => window.desktop.workspace())).repositories[0];
  await nav.getByRole("button", { name: "Repositories", exact: true }).click();
  await expect(observer.getByText(repository.name, { exact: true }).last()).toBeVisible();
  await writer.evaluate(async (folder) => {
    await window.desktop.saveSetup({ codeFolder: folder });
    await window.desktop.scanCode("view-repositories", folder, () => {});
    await window.desktop.applyRepositories([]);
  }, path.dirname(repository.path));
  await expect(
    observer.locator(".repository-hosts").getByText(repository.name, { exact: true }),
  ).toHaveCount(0);
});
test("data views: main write-to-push latency is measured with the real sandboxed bridge", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  const timings = await page.evaluate(async () => {
    let observed;
    let wake = () => {};
    const off = window.desktop.subscribeView("settings", {}, (snapshot) => {
      observed = snapshot;
      wake();
    });
    try {
      if (!observed)
        await new Promise((resolve) => {
          wake = resolve;
        });
      const samples = [];
      for (const value of [true, false, true, false, true]) {
        const start = performance.now();
        const pushed = new Promise((resolve) => {
          wake = resolve;
        });
        await window.desktop.saveSetup({ showNestedRepositoryNames: value });
        if (observed.data.settings.showNestedRepositoryNames !== value) await pushed;
        samples.push(performance.now() - start);
      }
      return samples;
    } finally {
      off();
    }
  });
  context.diagnostic(`write-to-push milliseconds: ${JSON.stringify(timings)}`);
  assert.ok(Math.max(...timings) < deadline(2000), JSON.stringify(timings));
});
