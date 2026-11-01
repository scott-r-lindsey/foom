import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type * as discovery from "../../../../src/terminal-host/remote/agent-discovery";
import type * as fsPromises from "node:fs/promises";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mock = vi.hoisted(() => ({
  probe: vi.fn(),
  paths: new Set<string>(),
  file: "",
  nonFile: false,
}));
vi.mock("../../../../src/terminal-host/remote/agent-discovery", async (original) => ({
  ...(await original<typeof discovery>()),
  hostProbe: mock.probe,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof fsPromises>();
  return {
    ...fs,
    open: (path: string, flags: number) =>
      fs.open(path === "/etc/os-release" ? mock.file : path, flags),
    access: (path: string) =>
      mock.paths.has(path) ? Promise.resolve() : Promise.reject(new Error("missing")),
    stat: () => Promise.resolve({ isFile: () => !mock.nonFile }),
  };
});
import { HostProbeExit } from "../../../../src/terminal-host/remote/agent-discovery";
import {
  hostDistro,
  hostLibc,
  macSleep,
  protectedCodeFolder,
  executable,
  requirements,
  signInStatus,
} from "../../../../src/terminal-host/remote/host-facts";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "host-facts-"));
  mock.file = join(root, "os-release");
  mock.paths.clear();
  mock.nonFile = false;
  mock.probe.mockReset().mockResolvedValue("");
  await writeFile(mock.file, "ID=ubuntu\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
test.each([
  ["ubuntu", "debian"],
  ["debian", "debian"],
  ["rhel", "rhel"],
  ["rocky", "rhel"],
  ["almalinux", "rhel"],
  ["fedora", "rhel"],
  ["amzn", "rhel"],
  ["centos", "rhel"],
  ["arch", "arch"],
  ["other", "unknown"],
])("maps distro %s", (id, distro) => {
  expect(hostDistro(`ID=${id}\n`)).toBe(distro);
});
test("ID wins, ID_LIKE falls back in order, and malformed data never becomes shell code", () => {
  expect(hostDistro('NAME="A distro"\nID=custom\nID_LIKE="other debian rhel"\n')).toBe("debian");
  expect(hostDistro("ID='arch'\nID_LIKE=debian\n")).toBe("arch");
  expect(hostDistro("# comment\n\nID_LIKE='unknown fedora'\n")).toBe("rhel");
  for (const source of [
    "ID=ubuntu\nID=arch",
    "ID=$(id)",
    "ID=`id`",
    'ID="ubuntu',
    "ID=ubuntu\r\n",
    "ID=ubuntu\0",
    "bad",
    "X=" + "x".repeat(65536),
    "ID_LIKE=unknown",
    "",
  ])
    expect(hostDistro(source)).toBe("unknown");
});
test.each([
  ["glibc 2.28\n", "supported"],
  ["glibc 2.40", "supported"],
  ["glibc 3.0", "supported"],
  ["glibc 2.17", "too-old"],
  ["glibc 1.99", "too-old"],
  ["musl 1.2", "unsupported"],
  ["glibc 2.28\nextra", "unsupported"],
  ["", "unsupported"],
])("libc reduces %s", (value, state) => {
  expect(hostLibc(value)).toBe(state);
});
test("Mac sleep checks every source and protected paths use boundaries", () => {
  expect(
    macSleep("Battery Power:\n sleep 0\nAC Power:\n sleep 0 (sleep prevented by process)\n"),
  ).toBe(true);
  for (const source of ["", " sleep 1\n", " sleep 0\n sleep 10\n"])
    expect(macSleep(source)).toBe(false);
  for (const name of ["Documents", "Desktop", "Downloads"]) {
    expect(protectedCodeFolder(`/home/u/${name}`, "/home/u")).toBe(true);
    expect(protectedCodeFolder(`/home/u/${name}/code`, "/home/u")).toBe(true);
  }
  expect(protectedCodeFolder("/home/u/DocumentsElse", "/home/u")).toBe(false);
});
test("Linux reads fixture os-release, uses fixed getconf and package-manager paths", async () => {
  mock.probe.mockResolvedValue("glibc 2.28\n");
  for (const [id, path, manager] of [
    ["ubuntu", "/usr/bin/apt-get", "apt"],
    ["rocky", "/usr/bin/dnf", "dnf"],
    ["arch", "/usr/bin/pacman", "pacman"],
    ["other", "/usr/bin/pacman", "none"],
  ]) {
    await writeFile(mock.file, `ID=${id ?? ""}\n`);
    mock.paths.add(path ?? "");
    expect(await requirements("linux", root, root, {})).toMatchObject({
      packageManager: manager,
      libc: "supported",
    });
  }
  expect(mock.probe).toHaveBeenCalledWith(
    "/usr/bin/getconf",
    ["GNU_LIBC_VERSION"],
    root,
    expect.objectContaining({ LANG: "C", LC_ALL: "C" }),
    false,
    5000,
    undefined,
  );
  mock.paths.clear();
  expect(await executable("/missing")).toBe(false);
  mock.paths.add("/not-file");
  mock.nonFile = true;
  expect(await executable("/not-file")).toBe(false);
  await writeFile(mock.file, "x".repeat(65537));
  expect((await requirements("linux", root, root, {})).distro).toBe("unknown");
  await writeFile(mock.file, Buffer.from([255]));
  expect((await requirements("linux", root, root, {})).distro).toBe("unknown");
  await rm(mock.file);
  expect((await requirements("linux", root, root, {})).distro).toBe("unknown");
});
test("Mac only discovers fixed Homebrew paths in login PATH; probes never launch an install dialog", async () => {
  mock.paths.add("/opt/homebrew/bin/brew");
  mock.paths.add("/usr/local/bin/brew");
  mock.probe.mockImplementation((command: string) =>
    Promise.resolve(
      command.endsWith("xcode-select") ? "/Library/Developer/CommandLineTools\n" : " sleep 0\n",
    ),
  );
  expect(
    await requirements("darwin", "/home/u/Documents/code", "/home/u", {
      PATH: "/random:/opt/homebrew/bin",
    }),
  ).toEqual({
    distro: "darwin",
    libc: "supported",
    packageManager: "brew",
    mac: { commandLineTools: true, staysAwake: true, protectedFolder: true },
  });
  expect((await requirements("darwin", root, root, { PATH: "/random" })).packageManager).toBe(
    "none",
  );
  mock.probe.mockRejectedValue(new Error("unavailable"));
  expect((await requirements("darwin", root, root, { PATH: "/usr/local/bin" })).mac).toEqual({
    commandLineTools: false,
    staysAwake: false,
    protectedFolder: false,
  });
  expect((await requirements("other", root, root, {})).libc).toBe("unsupported");
  await expect(requirements("other", root, root, {}, AbortSignal.abort())).rejects.toThrow();
});
test("sign-in is exit-code-only; status output is discarded and failures remain unknown", async () => {
  expect(await signInStatus("/fixture/gh", ["auth", "status"], root, {})).toBe("signed-in");
  expect(mock.probe).toHaveBeenLastCalledWith(
    "/fixture/gh",
    ["auth", "status"],
    root,
    {},
    false,
    5000,
    undefined,
    "status",
  );
  for (const [error, state] of [
    [new HostProbeExit(1), "signed-out"],
    [new HostProbeExit(2), "unknown"],
    [new HostProbeExit(null), "unknown"],
    [new Error("timeout"), "unknown"],
  ]) {
    mock.probe.mockRejectedValue(error);
    expect(await signInStatus("/fixture/gh", [], root, {})).toBe(state);
  }
});
