const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { gitSync } = require("../helpers/git.js");
const { evidencePath } = require("../helpers/evidence.js");
const { deadline, expect } = require("./test-policy.js");
const {
  launchApp,
  boardPage,
  confirmationPage,
  quitAndWait,
  openSettingsScreen,
  removeAfterApps,
} = require("./harness.js");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
async function capture(page, label) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${theme}` }),
      theme,
    );
    await expect
      .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
      .toBe(theme === "dark");
    await page
      .getByRole("region", { name: "Settings", exact: true })
      .screenshot({ path: evidencePath(`1080b/${label}-${theme}.png`) });
  }
}
async function approveDialog(app, board, label) {
  const dialog = await confirmationPage(app);
  await expect(dialog.getByRole("alertdialog")).toBeVisible();
  if (label) {
    for (const theme of ["light", "dark"]) {
      await board.evaluate(
        (theme) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${theme}` }),
        theme,
      );
      await expect
        .poll(() => dialog.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
        .toBe(theme === "dark");
      await dialog.screenshot({ path: evidencePath(`1080b/${label}-${theme}.png`) });
    }
  }
  await dialog.getByRole("button", { name: "Approve list", exact: true }).click();
  await expect(dialog.getByRole("alertdialog")).toHaveCount(0);
}
test("repository setup separates approval from human execution and rechecks failure, success and stale sources", {
  timeout: deadline(60_000),
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "repository-setup-"));
  removeAfterApps(context, root);
  const scenario = path.join(root, "state");
  const calls = path.join(root, "calls");
  await writeFile(scenario, "missing");
  await writeFile(
    path.join(root, "foom"),
    `#!/bin/sh
set -eu
[ -z "\${FOOM_CONTROL_TOKEN-}" ] || exit 99
[ "$FOOM_SETTINGS_INSTALL" = 1 ] || exit 98
printf '%s\\n' "$@" >> ${quote(calls)}
printf 'Fixture setup waiting for input\\n'
read answer
case "$answer" in
success) printf met > ${quote(scenario)}; exit 0 ;;
*) printf 'Failed · step 1 · exit 7\\n'; exit 7 ;;
esac
`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(root, "claude"),
    '#!/bin/sh\ncase "$1" in\n--version) printf "Claude Code 2.1.284\\n" ;;\n--help) printf -- "--settings\\n" ;;\n*) exit 99 ;;\nesac\n',
    { mode: 0o755 },
  );
  const app = await launchApp(context, { fixture: "repository", env: { PATH: root } });
  const page = await boardPage(app);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(1400, 1000),
  );
  const repository = (await page.evaluate(() => window.desktop.workspace())).repositories[0].path;
  await writeFile(path.join(repository, "package.json"), '{"name":"fixture"}\n');
  gitSync(["-C", repository, "add", "package.json"]);
  gitSync([
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "fixture",
  ]);
  await app.evaluate(
    (_electron, { root, scenario, servicePath, workspacePath }) => {
      const load = process.getBuiltinModule("node:module").createRequire(servicePath);
      const { RepositorySetup } = load(servicePath);
      const originalAction = RepositorySetup.prototype.action;
      RepositorySetup.prototype.action = function (...args) {
        this.deps.check = async (_host, list) => {
          const state = process.getBuiltinModule("node:fs").readFileSync(scenario, "utf8");
          return {
            platform: { distro: "debian", os: "linux", arch: "x64", nodeAbi: true },
            items: list.requirements.map((item) => ({
              id: item.id,
              state: item.kind === "toolchain" && item.version !== "24.x" ? "missing" : state,
            })),
          };
        };
        return originalAction.apply(this, args);
      };
      const { Workspace } = load(workspacePath);
      const original = Workspace.prototype.startRepositorySetup;
      Workspace.prototype.startRepositorySetup = async function (...args) {
        const config = this.owner.deps.config;
        const previous = config.cliDirectory;
        config.cliDirectory = root;
        try {
          return await original.apply(this, args);
        } finally {
          config.cliDirectory = previous;
        }
      };
    },
    {
      root,
      scenario,
      servicePath: path.resolve("build/main/setup/repository-setup.js"),
      workspacePath: path.resolve("build/main/workspace/workspace.js"),
    },
  );
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Hosts", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Repository setup", exact: true });
  await expect(panel.getByText("No setup list", { exact: false })).toBeVisible();
  await panel.getByRole("button", { name: "Create list", exact: true }).click();
  await capture(page, "empty");
  const draft = {
    requirements: [
      {
        kind: "toolchain",
        id: "node",
        tool: "node",
        version: "24.x",
        purpose: "Run fixture build tooling",
        sources: ["package.json"],
      },
      {
        kind: "package",
        id: "native",
        purpose: "Compile fixture native modules",
        sources: ["package.json"],
        packages: { debian: ["gcc"], rhel: ["gcc"], arch: ["gcc"], darwin: ["pkg-config"] },
      },
    ],
    evidence: [],
  };
  await panel.getByRole("textbox", { name: "Setup draft JSON" }).fill(JSON.stringify(draft));
  await panel.getByRole("button", { name: "Review draft", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Approve list", exact: true })).toBeVisible();
  await capture(page, "review");
  assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals.length, 0);
  await panel.getByRole("button", { name: "Approve list", exact: true }).click();
  await approveDialog(app, page, "approval");
  assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals.length, 0);
  await panel
    .getByRole("button", { name: "Recheck shell-fixture setup on This computer", exact: true })
    .click();
  await expect(panel.getByText("Needs setup", { exact: false })).toBeVisible();
  await capture(page, "hosts");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(720, 900),
  );
  await capture(page, "narrow");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(1400, 1000),
  );
  await panel.getByRole("button", { name: "Set up", exact: true }).click();
  await expect(panel.locator(".xterm-screen")).toContainText("Fixture setup waiting");
  await capture(page, "running");
  const terminals = (await page.evaluate(() => window.desktop.workspace())).terminals;
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].recipe, true);
  assert.equal(terminals[0].agent, "shell");
  await expect(
    panel.getByRole("region", { name: "Install terminal", exact: true }),
  ).toHaveAttribute("aria-busy", "false");
  await panel.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("fail");
  await page.keyboard.press("Enter");
  await expect(panel.getByText("Failed · exit code 7", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Set up", exact: true })).toBeVisible();
  await capture(page, "failed");
  await panel.getByRole("button", { name: "Set up", exact: true }).click();
  await expect(panel.locator(".xterm-screen")).toContainText("Fixture setup waiting");
  await expect(
    panel.getByRole("region", { name: "Install terminal", exact: true }),
  ).toHaveAttribute("aria-busy", "false");
  await panel.locator(".xterm-screen").click();
  await panel.locator(".xterm-helper-textarea").pressSequentially("success");
  await panel.locator(".xterm-helper-textarea").press("Enter");
  await expect(panel.getByText("Requirements met", { exact: false }))
    .toBeVisible()
    .catch(async (error) => {
      const rows = (await page.evaluate(() => window.desktop.workspace())).terminals;
      console.error("Fixture setup retry", {
        state: await readFile(scenario, "utf8"),
        rows,
        tails: await page.evaluate(
          async (ids) => Promise.all(ids.map((id) => window.desktop.tail(id, 20))),
          rows.map((row) => row.id),
        ),
      });
      throw error;
    });
  await capture(page, "met");
  await writeFile(path.join(repository, "package.json"), '{"name":"fixture","changed":true}\n');
  await panel
    .getByRole("button", { name: "Recheck shell-fixture setup on This computer", exact: true })
    .click();
  await expect(panel.getByText("Review needed", { exact: false })).toBeVisible();
  await capture(page, "stale");
  await panel.getByRole("button", { name: "Review list", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Keep list", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Edit draft", exact: true }).click();
  draft.requirements[0].version = "26.x";
  await panel.getByRole("textbox", { name: "Setup draft JSON" }).fill(JSON.stringify(draft));
  await panel.getByRole("button", { name: "Review draft", exact: true }).click();
  await panel.getByRole("button", { name: "Approve list", exact: true }).click();
  await approveDialog(app, page, "replacement");
  await panel
    .getByRole("button", { name: "Recheck shell-fixture setup on This computer", exact: true })
    .click();
  await expect(panel.getByText("Manual setup required", { exact: false })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Set up", exact: true })).toHaveCount(0);
  await capture(page, "unsupported");
  await page.evaluate(() => window.desktop.saveSetup({ agents: { claude: true } }));
  const before = (await page.evaluate(() => window.desktop.workspace())).terminals.length;
  const refused = await page.evaluate(
    (repository) =>
      window.desktop
        .launchAgent({ agent: "claude", repository, worktree: repository, cols: 80, rows: 24 })
        .then(
          () => "unexpected",
          (error) => error.message,
        ),
    repository,
  );
  assert.match(refused, /repository-setup-manual/u);
  assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals.length, before);
  assert.match(await readFile(calls, "utf8"), /--repository-setup/u);
  await page.getByRole("region", { name: "Settings", exact: true }).press("Escape");
  await expect(page.getByRole("region", { name: "Settings", exact: true })).toHaveCount(0);
  await page.evaluate(() => window.desktop.scanAgents(true));
  await page.getByRole("button", { name: "Actions for Main checkout", exact: true }).click();
  await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
  const refusal = page.getByRole("dialog", { name: "Action failed", exact: true });
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText("node");
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${theme}` }),
      theme,
    );
    await page.screenshot({ path: evidencePath(`1080b/launch-${theme}.png`) });
  }
  await refusal.getByRole("button", { name: "Open setup", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Repository setup", exact: true })
      .locator(".repository-setup-row"),
  ).toBeFocused();
  const first = await page.evaluate(
    (repository) => window.desktop.repositorySetup({ action: "review", repository }),
    repository,
  );
  const windowsBefore = new Set(app.windows());
  await page.evaluate(() => window.desktop.appMenu.execute("new-window"));
  await expect
    .poll(
      () =>
        app
          .windows()
          .filter(
            (window) => !windowsBefore.has(window) && window.url() === "app://bundle/index.html",
          ).length,
    )
    .toBe(1);
  const second = app
    .windows()
    .find((window) => !windowsBefore.has(window) && window.url() === "app://bundle/index.html");
  await second.waitForURL("app://bundle/index.html");
  const other = await second.evaluate(
    (repository) => window.desktop.repositorySetup({ action: "review", repository }),
    repository,
  );
  const pendingApproval = page.evaluate(
    (token) => window.desktop.repositorySetup({ action: "approve", token }),
    first.review.token,
  );
  await approveDialog(app, page);
  await pendingApproval;
  assert.equal(
    await second.evaluate(
      (token) =>
        window.desktop.repositorySetup({ action: "approve", token }).then(
          () => false,
          () => true,
        ),
      other.review.token,
    ),
    true,
  );
  // A board-held token must not weaken the prerequisite, including an empty replacement.
  const beforeEmpty = await page.evaluate(() => window.desktop.repositorySetup({ action: "list" }));
  const empty = await page.evaluate(
    (repository) =>
      window.desktop.repositorySetup({
        action: "review",
        repository,
        draft: JSON.stringify({ requirements: [], evidence: [] }),
      }),
    repository,
  );
  const pendingEmpty = page.evaluate(
    (token) => window.desktop.repositorySetup({ action: "approve", token }),
    empty.review.token,
  );
  const trusted = await confirmationPage(app);
  await expect(trusted.getByRole("alertdialog")).toHaveAccessibleName(
    "Replace repository setup list?",
  );
  await expect(trusted.getByRole("alertdialog")).toContainText(
    "remove all repository launch prerequisites",
  );
  const id = await trusted.evaluate(() => {
    let id;
    const off = window.confirmation.render((request) => {
      id = request?.id;
    });
    off();
    return id;
  });
  await app.evaluate(({ BrowserWindow, ipcMain }, id) => {
    const board = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    ).webContents;
    ipcMain.emit("confirmation:answer", { sender: board, senderFrame: board.mainFrame }, id, true);
  }, id);
  await expect(trusted.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  assert.equal(await page.evaluate(() => "confirmation" in window), false);
  const unchanged = await page.evaluate(() => window.desktop.repositorySetup({ action: "list" }));
  assert.deepEqual(unchanged.rows, beforeEmpty.rows);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${theme}` }),
      theme,
    );
    await expect
      .poll(() => trusted.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
      .toBe(theme === "dark");
    await trusted.screenshot({ path: evidencePath(`1080b/empty-approval-${theme}.png`) });
  }
  await trusted.getByRole("button", { name: "Cancel", exact: true }).click();
  await pendingEmpty;
  assert.deepEqual(
    (await page.evaluate(() => window.desktop.repositorySetup({ action: "list" }))).rows,
    beforeEmpty.rows,
  );
});

test("repository setup IPC refuses source edits during launch preparation before creating a terminal", {
  timeout: deadline(45_000),
  skip: process.platform === "win32",
}, async (context) => {
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  const repository = (await page.evaluate(() => window.desktop.workspace())).repositories[0].path;
  await writeFile(path.join(repository, "package.json"), '{"name":"before"}\n');
  await app.evaluate(
    (_electron, { servicePath, workspacePath }) => {
      const load = process.getBuiltinModule("node:module").createRequire(servicePath);
      const { RepositorySetup } = load(servicePath);
      const action = RepositorySetup.prototype.action;
      RepositorySetup.prototype.action = function (...args) {
        this.deps.check = (_host, list) =>
          Promise.resolve({
            platform: { distro: "debian", os: "linux", arch: "x64", nodeAbi: true },
            items: list.requirements.map((item) => ({ id: item.id, state: "missing" })),
          });
        return action.apply(this, args);
      };
      const { Workspace } = load(workspacePath);
      const start = Workspace.prototype.startRepositorySetup;
      Workspace.prototype.startRepositorySetup = async function (...args) {
        await Promise.resolve();
        process
          .getBuiltinModule("node:fs")
          .writeFileSync(
            process.getBuiltinModule("node:path").join(args[0].location.path, "package.json"),
            '{"name":"changed-during-preparation"}\n',
          );
        return start.apply(this, args).catch((error) => {
          globalThis.repositorySetupDispatchFailure = error.message;
          throw error;
        });
      };
    },
    {
      servicePath: path.resolve("build/main/setup/repository-setup.js"),
      workspacePath: path.resolve("build/main/workspace/workspace.js"),
    },
  );
  const reviewed = await page.evaluate(
    (repository) =>
      window.desktop.repositorySetup({
        action: "review",
        repository,
        draft: JSON.stringify({
          requirements: [
            {
              kind: "toolchain",
              id: "node",
              tool: "node",
              version: "24.x",
              purpose: "Build",
              sources: ["package.json"],
            },
          ],
          evidence: [],
        }),
      }),
    repository,
  );
  const pending = page.evaluate(
    (token) => window.desktop.repositorySetup({ action: "approve", token }),
    reviewed.review.token,
  );
  await approveDialog(app, page);
  await pending;
  const checked = await page.evaluate(
    (repository) => window.desktop.repositorySetup({ action: "check", repository, host: null }),
    repository,
  );
  const token = checked.rows.find((row) => row.host === null).token;
  assert.ok(token);
  const refusal = await page.evaluate(
    (token) =>
      window.desktop.repositorySetup({ action: "run", token }).then(
        () => "unexpected",
        (error) => error.message,
      ),
    token,
  );
  assert.match(refusal, /foom-error:operation-failed/u);
  assert.equal(
    await app.evaluate(() => globalThis.repositorySetupDispatchFailure),
    "Repository sources changed before dispatch",
  );
  assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals.length, 0);
});

test("catalog-v1 setup approvals preserve the launch block and open an editable review after restart", {
  timeout: deadline(60_000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "setup-legacy-profile-"));
  removeAfterApps(context, root);
  const profile = path.join(root, "profile");
  const first = await launchApp(context, {
    fixture: "repository",
    args: [`--user-data-dir=${profile}`],
  });
  const board = await boardPage(first);
  const repository = (await board.evaluate(() => window.desktop.workspace())).repositories[0].path;
  await writeFile(path.join(repository, "package.json"), "{}\n");
  const reviewed = await board.evaluate(
    (repository) =>
      window.desktop.repositorySetup({
        action: "review",
        repository,
        draft: JSON.stringify({ requirements: [], evidence: [] }),
      }),
    repository,
  );
  const pending = board.evaluate(
    (token) => window.desktop.repositorySetup({ action: "approve", token }),
    reviewed.review.token,
  );
  await approveDialog(first, board);
  await pending;
  await quitAndWait(first, () => first.evaluate(({ app }) => app.quit()));
  const file = path.join(profile, "repository-setup", "state.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  const legacy = require("../fixtures/repository-setup/catalog-v1-approval.json");
  saved.approvals[0] = {
    ...saved.approvals[0],
    list: legacy.list,
    digest: legacy.digest,
    catalog: legacy.catalog,
    revision: 7,
  };
  saved.rows = [
    {
      repository,
      host: null,
      revision: 7,
      state: "met",
      missing: [],
      changed: [],
      sourcesAtLaunch: false,
    },
  ];
  await writeFile(file, JSON.stringify(saved), { mode: 0o600 });
  const app = await launchApp(context, {
    fixture: "restored",
    args: [`--user-data-dir=${profile}`],
  });
  const page = await boardPage(app);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(1400, 1000),
  );
  const state = await page.evaluate(() => window.desktop.repositorySetup({ action: "list" }));
  assert.equal(state.rows[0].state, "review-needed");
  assert.equal(state.rows[0].revision, 7);
  assert.equal(state.rows[0].token, undefined);
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Hosts", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Repository setup", exact: true });
  await expect(panel.getByText("Review needed", { exact: false })).toBeVisible();
  await capture(page, "legacy-blocked");
  await panel.getByRole("button", { name: "Review list", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("no longer supported");
  await expect(panel.getByRole("button", { name: "Keep list", exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Set up", exact: true })).toHaveCount(0);
  await capture(page, "legacy-review");
  await panel.getByRole("button", { name: "Edit draft", exact: true }).click();
  const editor = panel.getByRole("textbox", { name: "Setup draft JSON" });
  const draft = JSON.parse(await editor.inputValue());
  assert.deepEqual(draft.requirements[0].packages.debian, ["g++", "libfoo1.2"]);
  await capture(page, "legacy-edit");
  draft.requirements[0].packages.debian = ["gcc"];
  await editor.fill(JSON.stringify(draft));
  await panel.getByRole("button", { name: "Review draft", exact: true }).click();
  await panel.getByRole("button", { name: "Approve list", exact: true }).click();
  await approveDialog(app, page);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.repositorySetup({ action: "list" }))).rows[0]
          .revision,
    )
    .toBe(8);
  assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals.length, 0);
});
