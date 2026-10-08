import { afterEach, expect, it, vi } from "vitest";
import { ControlError } from "../../../src/node-common/control-validation";
import type { ConsoleIo } from "../../../src/cli/types";
vi.mock("../../../src/cli/client", () => ({
  inherited: vi.fn(),
  profilePath: vi.fn(() => "/profile"),
  pair: vi.fn((_profile, _repository, announce: (code: string) => void) => {
    announce("ABCD1234");
    return Promise.resolve({ token: "SECRET" });
  }),
  call: vi.fn(() => Promise.resolve({ state: "quiet_ok" })),
}));
vi.mock("../../../src/cli/install", () => ({
  installCli: vi.fn(() => Promise.resolve("Installed")),
}));
import { inherited, pair, call } from "../../../src/cli/client";
import { installCli } from "../../../src/cli/install";
import { execute } from "../../../src/cli/execute";
const io = (lines: string[] = []): ConsoleIo => ({
  out: vi.fn(),
  error: vi.fn(),
  input: (async function* () {
    for (const line of lines) yield await Promise.resolve(line);
  })(),
});
afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(inherited).mockReturnValue(undefined);
});
it("runs offline commands and reports fixed usage failures without discovery", async () => {
  for (const args of [[], ["--help"], ["--version"], ["--version", "--json"]])
    expect(await execute(args, "1", io(), {}, "/foom")).toBe(0);
  expect(await execute(["--validate-config", "/input"], "1", io(), {}, "/foom")).toBe(2);
  for (const args of [
    Array<string>(33).fill("x"),
    ["x".repeat(4097)],
    ["--json", "--json"],
    ["--unknown"],
  ])
    expect(await execute(args, "1", io(), {}, "/foom")).toBe(2);
  expect(pair).not.toHaveBeenCalled();
});
it("uses inherited scope exclusively and never falls back after denial", async () => {
  vi.mocked(inherited).mockReturnValue({ token: "SECRET", endpoint: "local", instanceId: "id" });
  const output = io();
  expect(await execute(["whoami", "--json"], "1", output, {}, "/foom")).toBe(0);
  expect(output.out).toHaveBeenCalledWith('{"result":{"state":"quiet_ok"}}\n');
  for (const args of [
    ["pair"],
    ["whoami", "--repository", "/repo"],
    ["whoami", "--profile", "/profile"],
    ["--install-cli", "/bin"],
  ])
    expect(await execute(args, "1", output, {}, "/foom")).toBe(3);
  vi.mocked(call).mockRejectedValueOnce(new ControlError("unauthorized"));
  expect(await execute(["whoami"], "1", output, {}, "/foom")).toBe(3);
  expect(pair).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(output.out).mock.calls)).not.toContain("SECRET");
});
it("requires explicit human repository scope, negotiates pairing and keeps the grant in one process", async () => {
  expect(await execute(["whoami"], "1", io(), {}, "/foom")).toBe(3);
  const output = io(['["sessions"]\n["whoami"]\n']);
  expect(
    await execute(
      ["pair", "--repository", "/repo", "--profile", "/profile", "--json"],
      "1",
      output,
      {},
      "/foom",
    ),
  ).toBe(0);
  expect(pair).toHaveBeenCalledWith("/profile", "/repo", expect.any(Function));
  expect(output.out).toHaveBeenCalledWith('{"ready":true,"protocol":1}\n');
  expect(output.error).toHaveBeenCalledWith(expect.stringContaining("ABCD1234"));
  expect(call).toHaveBeenCalledTimes(3);
  expect(await execute(["whoami", "--repository", "/repo"], "1", io(), {}, "/foom")).toBe(0);
});
it("rejects malformed persistent input and emits fixed errors without raw exception text", async () => {
  for (const chunks of [
    ["x".repeat(65537)],
    ["[3]\n"],
    ["{}\n"],
    ['["whoami"]'],
    ['["unknown"]\n'],
  ])
    expect(await execute(["pair", "--repository", "/repo"], "1", io(chunks), {}, "/foom")).toBe(2);
  const output = io();
  vi.mocked(pair).mockRejectedValueOnce(new Error("SECRET raw I/O"));
  expect(await execute(["whoami", "--repository", "/repo"], "1", output, {}, "/foom")).toBe(4);
  expect(output.error).toHaveBeenCalledWith('{"error":"unavailable"}\n');
  for (const args of [
    ["whoami", "--repository"],
    ["whoami", "--profile", "--bad"],
    ["whoami", "--repository", "/a", "--repository", "/b"],
    ["whoami", "--profile", "/a", "--profile", "/b"],
  ])
    expect(await execute(args, "1", io(), {}, "/foom")).toBe(2);
});
it("makes PATH edits only through explicit install and uninstall commands", async () => {
  for (const name of ["--install-cli", "--uninstall-cli"])
    expect(await execute([name, "/bin"], "1", io(), {}, "/foom")).toBe(0);
  expect(installCli).toHaveBeenLastCalledWith("/foom", "/bin", true, {});
  expect(await execute(["--install-cli", "/bin", "extra"], "1", io(), {}, "/foom")).toBe(2);
  if (process.platform !== "win32")
    expect(await execute(["--install-cli"], "1", io(), {}, "/foom")).toBe(2);
});

it("release failure cannot leak credentials or replace the successful result", async () => {
  vi.mocked(call)
    .mockResolvedValueOnce({ ok: true })
    .mockRejectedValueOnce(new Error("disconnected"));
  expect(await execute(["whoami", "--repository", "/repo"], "1", io(), {}, "/foom")).toBe(0);
});
