const path = require("node:path");
const { mkdir, mkdtemp, writeFile, chmod } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { gitSync } = require("../helpers/git.js");
const { boardPage, launchApp, removeAfterApps } = require("./harness.js");
const { waitForFixtureRecord } = require("./fixture-records.js");

async function launchFixtureRepository(context, repo, options) {
  const app = await launchApp(context, options);
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, repo);
  const repository = await page.evaluate(() => window.desktop.addRepository());
  return { app, page, repository };
}

async function codexFixture(context, { prefix = "foom-inline-", source, helpText }) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await Promise.all([mkdir(bin), mkdir(repo), mkdir(home)]);
  const help = path.join(root, "help");
  const cli = path.join(bin, "codex");
  await writeFile(cli, source({ help }));
  await chmod(cli, 0o755);
  gitSync(["init", "-q", "-b", "main"], { cwd: repo });
  gitSync(
    [
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ],
    { cwd: repo },
  );
  if (helpText !== undefined) await writeFile(help, helpText);
  return {
    root,
    repo,
    help,
    ...(await launchFixtureRepository(context, repo, {
      fixture: "agent",
      env: { HOME: home, PATH: bin },
    })),
  };
}

async function launchTrustedParent(context, { repo, credentials, options }) {
  const { app, page, repository } = await launchFixtureRepository(context, repo, options);
  await page.evaluate(
    ({ repository }) =>
      window.desktop.sidebarCommand({
        kind: "launch",
        repository,
        worktree: repository,
        run: "claude",
      }),
    { repository: repository.path },
  );
  // Reuse the fixture's atomic completion marker and case cancellation.
  await waitForFixtureRecord(`${credentials}.app`, [], context.signal);
  const parent = JSON.parse(
    await require("node:fs/promises").readFile(`${credentials}.app`, "utf8"),
  );
  return { app, page, repository: repository.path, parent };
}

module.exports = { codexFixture, launchTrustedParent };
