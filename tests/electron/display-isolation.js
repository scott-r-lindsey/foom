const assert = require("node:assert/strict");
const { readFileSync, readlinkSync } = require("node:fs");
const path = require("node:path");

// xvfb-run starts Xvfb beside the test command. Verify that server's identity,
// display, authority file and owning wrapper, rather than trusting DISPLAY alone.
function assertXvfbDisplay(env, system = { readFileSync, readlinkSync, pid: process.pid }) {
  const fail = "Electron tests require their own xvfb-run display";
  const match = /^:(\d+)(?:\.0)?$/.exec(env.DISPLAY ?? "");
  assert.ok(match && env.XAUTHORITY, fail);
  try {
    const server = system.readFileSync(`/tmp/.X${match[1]}-lock`, "utf8").trim();
    assert.match(server, /^[1-9]\d*$/, fail);
    assert.equal(path.basename(system.readlinkSync(`/proc/${server}/exe`)), "Xvfb", fail);
    const args = system.readFileSync(`/proc/${server}/cmdline`, "utf8").split("\0");
    assert.equal(args[1], `:${match[1]}`, fail);
    assert.equal(args[args.indexOf("-auth") + 1], env.XAUTHORITY, fail);
    const parent = (pid) => {
      const status = system.readFileSync(`/proc/${pid}/status`, "utf8");
      const value = /^PPid:\s+(\d+)$/m.exec(status)?.[1];
      assert.ok(value, fail);
      return Number(value);
    };
    const owner = parent(server);
    const command = system.readFileSync(`/proc/${owner}/cmdline`, "utf8").split("\0");
    assert.ok(
      command.some((arg) => path.basename(arg) === "xvfb-run"),
      fail,
    );
    const visited = new Set();
    let pid = system.pid;
    while (pid > 1 && pid !== owner && !visited.has(pid)) {
      visited.add(pid);
      pid = parent(pid);
    }
    assert.equal(pid, owner, fail);
  } catch (cause) {
    throw new Error(fail, { cause });
  }
}

function electronLaunch(options, platform = process.platform, verify = assertXvfbDisplay) {
  const env = { ...options.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (platform !== "linux") return { env, args: [...options.args] };
  verify(env);
  delete env.WAYLAND_DISPLAY;
  delete env.WAYLAND_SOCKET;
  env.XDG_SESSION_TYPE = "x11";
  // Kept for older Electron installations; Electron 44 uses the explicit flag.
  env.ELECTRON_OZONE_PLATFORM_HINT = "x11";
  const args = [];
  for (let index = 0; index < options.args.length; index++) {
    const arg = options.args[index];
    if (/^--ozone-platform(?:-hint)?$/.test(arg)) index++;
    else if (!/^--ozone-platform(?:-hint)?=/.test(arg)) args.push(arg);
  }
  args.push("--ozone-platform=x11");
  return { env, args };
}

module.exports = { assertXvfbDisplay, electronLaunch };
