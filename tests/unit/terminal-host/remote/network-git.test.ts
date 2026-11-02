import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { networkGit } from "../../../../src/terminal-host/remote/network-git";
import { gitFailureReason } from "../../../../src/terminal-host/remote/git-failure";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "network-git-")));
  // This fixture never executes Git, SSH, a credential helper or the network.
  await writeFile(
    join(root, "git"),
    `#!${process.execPath}
const assert=require('node:assert/strict');
const args=process.argv.slice(2);
if(args.includes('config')) {
 assert.deepEqual(args,['config','--default','ssh','--get','core.sshCommand']);
 if(process.env.CONFIG_FAIL)process.exit(3);
 console.log(process.env.CONFIG_SSH||'ssh');process.exit(0);
}
assert.equal(process.env.GIT_TERMINAL_PROMPT,'0');
assert.equal(process.env.GIT_ASKPASS,'/usr/bin/false');
assert.equal(process.env.SSH_ASKPASS,'/usr/bin/false');
assert.equal(process.env.SSH_ASKPASS_REQUIRE,'never');
assert.equal(process.env.GIT_SSH_VARIANT,'ssh');
assert.equal(process.env.LC_ALL,'C');
assert.equal(process.env.GIT_SSH_COMMAND,(process.env.CONFIG_SSH||'ssh')+' -o BatchMode=yes');
if(process.env.HANG) {console.log('started');setTimeout(()=>{},600000);}
else if(process.env.OVERFLOW)process.stderr.write(Buffer.alloc(262145),()=>process.exit(128));
else if(process.env.DIAGNOSTIC) {process.stderr.write(process.env.DIAGNOSTIC+' PRIVATE_TOKEN');process.exit(128);}
else console.log('fixed-success');
`,
    { mode: 0o700 },
  );
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
const commands = [
  ["clone", "--", "git@fixture.test:team/repo.git", "destination"],
  ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
  ["ls-remote", "--symref", "origin", "HEAD"],
] as const;
const failures = [
  ["Permission denied (publickey).", "origin-auth"],
  [
    "Host key verification failed.\nfatal: Could not read from remote repository.",
    "origin-host-key",
  ],
  ["ssh: Could not resolve hostname fixture.test", "origin-unreachable"],
  ["ssh: connect to host fixture.test port 22: Connection timed out", "timed-out"],
  ["fatal: not a git repository", "checkout-invalid"],
] as const;
for (const args of commands) {
  test.skipIf(process.platform === "win32").each(failures)(
    `${args[0]} reduces %s to %s without retaining stderr`,
    async (diagnostic, reason) => {
      await expect(
        networkGit(args, root, { PATH: root, DIAGNOSTIC: diagnostic }, 5000),
      ).rejects.toMatchObject({ reason, message: `Remote Git failed: ${reason}` });
    },
  );
  test.skipIf(process.platform === "win32")(
    `${args[0]} has a bounded deadline and cancels its process group`,
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const kill = vi.spyOn(process, "kill");
      const pending = networkGit(
        args,
        root,
        { PATH: root, HANG: "1", GIT_SSH_COMMAND: "ssh" },
        10000,
      );
      const rejected = expect(pending).rejects.toMatchObject({ reason: "timed-out" });
      await vi.advanceTimersByTimeAsync(10000);
      await rejected;
      expect(kill).toHaveBeenCalledWith(expect.any(Number), "SIGKILL");
      const cancellation = new AbortController();
      const cancelled = networkGit(
        args,
        root,
        { PATH: root, HANG: "1", GIT_SSH_COMMAND: "ssh" },
        10000,
        cancellation.signal,
      );
      const checked = expect(cancelled).rejects.toMatchObject({ reason: "cancelled" });
      cancellation.abort();
      await checked;
    },
  );
}
test.skipIf(process.platform === "win32")(
  "host SSH options survive and every askpass source is disabled",
  async () => {
    const env = {
      PATH: root,
      CONFIG_SSH: 'ssh -i "/fixture/key with spaces" -o ProxyJump=fixture-jump -F /fixture/config',
      GIT_ASKPASS: "/fixture/prompt",
      SSH_ASKPASS: "/fixture/prompt",
      SSH_ASKPASS_REQUIRE: "force",
    };
    expect(await networkGit(commands[0], root, env, 5000)).toBe("fixed-success\n");
    expect(await networkGit([], root, { PATH: root }, 5000)).toBe("fixed-success\n");
    await expect(
      networkGit([], root, { PATH: root, CONFIG_FAIL: "1" }, 5000),
    ).rejects.toMatchObject({ reason: "origin-unreachable" });
    await expect(networkGit([], root, { PATH: root, OVERFLOW: "1" }, 5000)).rejects.toMatchObject({
      reason: "origin-unreachable",
    });
    await expect(networkGit([], root, { PATH: join(root, "missing") }, 5000)).rejects.toMatchObject(
      {
        reason: "origin-unreachable",
      },
    );
  },
);
test.each([
  ["REMOTE HOST IDENTIFICATION HAS CHANGED!", "origin-host-key"],
  ["No ED25519 host key is known and you have requested strict checking.", "origin-host-key"],
  ["fatal: Authentication failed for https://fixture.test", "origin-auth"],
  [
    "fatal: could not read Username for 'https://fixture.test': terminal prompts disabled",
    "origin-auth",
  ],
  ["remote: Invalid username or token.", "origin-auth"],
  ["Enter passphrase for key '/fixture/key':", "origin-auth"],
  [
    "sign_and_send_pubkey: signing failed for ED25519 from agent: agent refused operation",
    "origin-auth",
  ],
  ["remote: Repository not found.", "origin-auth"],
  ["fatal: unknown diagnostic PRIVATE_TOKEN", "origin-unreachable"],
])("classifies fixed diagnostic patterns without propagating %s", (diagnostic, reason) => {
  expect(gitFailureReason(diagnostic)).toBe(reason);
});
