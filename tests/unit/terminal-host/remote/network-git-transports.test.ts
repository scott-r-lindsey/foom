import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test } from "vitest";
import { gitSync } from "../../../helpers/git.js";
import { networkGit } from "../../../../src/terminal-host/remote/network-git";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "git-transports-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function script(name: string, code: string) {
  const path = join(root, name);
  await writeFile(path, `#!${process.execPath}\n${code}`, { mode: 0o700 });
  return path;
}
function environment(): NodeJS.ProcessEnv {
  // Production networkGit invokes system Git with fixture configuration only.
  // Every SSH transport is a fixture executable; no SSH or network is used.
  return {
    PATH: "/usr/bin",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: root,
    GIT_CONFIG_GLOBAL: join(root, "global-config"),
  };
}
const origin = "git@fixture.test:repo";
const advertisement = `process.stdout.write('0000');`;
const promptChecks = `
const assert=require('node:assert/strict'),fs=require('node:fs');
assert.equal(process.env.GIT_TERMINAL_PROMPT,'0');
assert.equal(process.env.GIT_ASKPASS,'/usr/bin/false');
assert.equal(process.env.SSH_ASKPASS,'/usr/bin/false');
assert.equal(process.env.SSH_ASKPASS_REQUIRE,'never');
assert.equal(process.env.GCM_INTERACTIVE,'never');
assert.ok(!process.stdin.isTTY);
let tty;try{tty=fs.openSync('/dev/tty','r')}catch{}
if(tty!==undefined){fs.closeSync(tty);throw new Error('Transport has a controlling terminal');}
`;

test.skipIf(process.platform === "win32").each(["config", "environment", "auto"] as const)(
  "%s simple transport rejects OpenSSH options and still advertises an empty repository",
  async (selection) => {
    const calls = join(root, "calls");
    const transport = await script(
      "simple-transport",
      `${promptChecks}
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args.includes('-G'))process.exit(1);
assert.ok(!args.some(arg=>arg==='-o'||arg.startsWith('-o')));
assert.equal(args[0],'git@fixture.test');
${advertisement}
`,
    );
    const repo = join(root, "repo");
    await mkdir(repo);
    gitSync(["init", "-q", repo]);
    gitSync(["config", "core.sshCommand", transport], { cwd: repo });
    gitSync(
      [
        "config",
        "ssh.variant",
        selection === "environment" ? "ssh" : selection === "auto" ? "auto" : "simple",
      ],
      { cwd: repo },
    );
    await writeFile(join(root, "global-config"), "");
    const env = environment();
    if (selection === "environment") env["GIT_SSH_VARIANT"] = "simple";
    expect(await networkGit(["ls-remote", origin], repo, env, 5000)).toBe("");
    const args = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line: string): unknown => JSON.parse(line));
    expect(args.at(-1)).toEqual(["git@fixture.test", "git-upload-pack 'repo'"]);
    if (selection === "auto") expect(args).toHaveLength(2);
  },
);

test.skipIf(process.platform === "win32")(
  "clone resolves conditional SSH configuration in its target repository",
  async () => {
    const wrong = await script(
      "wrong-transport",
      "process.stderr.write('WRONG_CONTEXT');process.exit(9);",
    );
    const calls = join(root, "conditional-calls");
    const transport = await script(
      "conditional-transport",
      `${promptChecks}
const args=process.argv.slice(2);assert.equal(args[0],'git@fixture.test');
assert.ok(!args.includes('-o'));
fs.writeFileSync(${JSON.stringify(calls)},'selected');
${advertisement}
`,
    );
    const codeFolder = join(root, "code");
    await mkdir(codeFolder);
    const target = join(codeFolder, "target");
    const conditional = join(root, "conditional-config");
    await writeFile(conditional, `[core]\nsshCommand = ${JSON.stringify(transport)}\n`);
    await writeFile(
      join(root, "global-config"),
      `[core]\nsshCommand = ${JSON.stringify(wrong)}\n[ssh]\nvariant = simple\n[includeIf "gitdir:${target}/.git"]\npath = ${JSON.stringify(conditional)}\n`,
    );
    // Git's isolated helper owns fixture setup; production code owns this clone.
    expect(await networkGit(["clone", "--", origin, target], codeFolder, environment(), 5000)).toBe(
      "",
    );
    expect(await readFile(calls, "utf8")).toBe("selected");
  },
);

test.skipIf(process.platform === "win32").each([
  [
    "passphrase",
    "read_passphrase: can't open /dev/tty\nPermission denied (publickey).",
    "origin-auth",
  ],
  ["unknown-host-key", "Host key verification failed.", "origin-host-key"],
] as const)(
  "%s fails without a terminal or askpass and retains its fixed reason",
  async (_mode, diagnostic, reason) => {
    const transport = await script(
      "ssh",
      `${promptChecks}
process.stderr.write(${JSON.stringify(diagnostic)});process.exit(255);
`,
    );
    const repo = join(root, "repo");
    await mkdir(repo);
    gitSync(["init", "-q", repo]);
    gitSync(["config", "core.sshCommand", transport], { cwd: repo });
    await writeFile(join(root, "global-config"), "");
    await expect(
      networkGit(["ls-remote", origin], repo, environment(), 5000),
    ).rejects.toMatchObject({ reason });
  },
);
