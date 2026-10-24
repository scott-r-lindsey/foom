import assert from "node:assert/strict";
import { test } from "node:test";
import isolation from "../tests/electron/display-isolation.js";
const { assertXvfbDisplay, electronLaunch } = isolation;

function server(overrides = {}) {
  const files = {
    "/tmp/.X99-lock": " 200\n",
    "/proc/200/cmdline": "/usr/bin/Xvfb\0:99\0-auth\0/tmp/owned/Xauthority\0",
    "/proc/200/status": "PPid:\t100\n",
    "/proc/100/cmdline": "/bin/sh\0/usr/bin/xvfb-run\0-a\0node\0",
    "/proc/400/status": "PPid:\t300\n",
    "/proc/300/status": "PPid:\t100\n",
    ...overrides,
  };
  return {
    pid: 400,
    readFileSync: (file) => {
      if (!(file in files)) throw new Error(`Missing fixture: ${file}`);
      return files[file];
    },
    readlinkSync: () => "/usr/bin/Xvfb",
  };
}
const env = { DISPLAY: ":99", XAUTHORITY: "/tmp/owned/Xauthority" };

test("Linux launches strip Wayland and enforce X11 after conflicting arguments", () => {
  const input = {
    env: {
      ...env,
      WAYLAND_DISPLAY: "real-compositor",
      WAYLAND_SOCKET: "7",
      XDG_RUNTIME_DIR: "/runtime",
      XDG_SESSION_TYPE: "wayland",
      ELECTRON_OZONE_PLATFORM_HINT: "wayland",
      ELECTRON_RUN_AS_NODE: "1",
    },
    args: ["app", "--ozone-platform=wayland", "--ozone-platform-hint", "auto", "--mute-audio"],
  };
  const result = electronLaunch(input, "linux", (value) => assertXvfbDisplay(value, server()));
  assert.deepEqual(result.args, ["app", "--mute-audio", "--ozone-platform=x11"]);
  assert.equal(result.env.WAYLAND_DISPLAY, undefined);
  assert.equal(result.env.WAYLAND_SOCKET, undefined);
  assert.equal(result.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(result.env.XDG_SESSION_TYPE, "x11");
  assert.equal(result.env.ELECTRON_OZONE_PLATFORM_HINT, "x11");
  assert.equal(result.env.DISPLAY, env.DISPLAY);
  assert.equal(result.env.XDG_RUNTIME_DIR, "/runtime");
  assert.equal(input.env.WAYLAND_DISPLAY, "real-compositor");
  assert.deepEqual(
    electronLaunch({ env, args: ["--ozone-platform", "wayland"] }, "linux", () => {}).args,
    ["--ozone-platform=x11"],
  );
});

test("macOS and Windows retain their environment and platform arguments", () => {
  for (const platform of ["darwin", "win32"]) {
    const input = { env: { WAYLAND_DISPLAY: "ignored" }, args: ["app"] };
    assert.deepEqual(
      electronLaunch(input, platform, () => assert.fail("Linux only")),
      input,
    );
  }
});

test("only the ancestor xvfb-run server and its authority can authorize a display", () => {
  assert.doesNotThrow(() => assertXvfbDisplay(env, server()));
  assert.doesNotThrow(() => assertXvfbDisplay({ ...env, DISPLAY: ":99.0" }, server()));
  for (const display of [undefined, "", ":0", "localhost:99", "real-host:0", ":99.1"]) {
    assert.throws(() => assertXvfbDisplay({ ...env, DISPLAY: display }, server()), /own xvfb-run/);
  }
  for (const files of [
    { "/tmp/.X99-lock": "not-a-pid" },
    { "/proc/200/cmdline": "/usr/bin/Xvfb\0:0\0-auth\0/tmp/owned/Xauthority\0" },
    { "/proc/200/cmdline": "/usr/bin/Xvfb\0:99\0-auth\0/another/Xauthority\0" },
    { "/proc/100/cmdline": "/bin/sh\0normal-desktop\0" },
    { "/proc/300/status": "PPid:\t1\n" },
    { "/proc/300/status": "PPid:\t400\n" },
  ])
    assert.throws(() => assertXvfbDisplay(env, server(files)), /own xvfb-run/);
  assert.throws(
    () => assertXvfbDisplay(env, { ...server(), readlinkSync: () => "/usr/bin/Xorg" }),
    /own xvfb-run/,
  );
  assert.throws(() => assertXvfbDisplay({ DISPLAY: ":99" }, server()), /own xvfb-run/);
});
