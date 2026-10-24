import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  checkSocket,
  hostSocket,
  privateDirectory,
} from "../../../../src/terminal-host/remote/private-path";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "private-host-")));
  roots.push(root);
  return root;
}
test.skipIf(process.platform === "win32")(
  "host paths reject links, foreign permissions, relative/traversal and long sockets",
  () => {
    const home = fixture();
    const socket = hostSocket(home);
    expect(socket).toBe(join(home, ".foom-host/host.sock"));
    expect(hostSocket(home)).toBe(socket);
    for (const path of ["relative", `${home}/../bad`, `${home}\0`])
      expect(() => {
        privateDirectory(path);
      }).toThrow();
    expect(() => hostSocket("relative")).toThrow();
    chmodSync(home, 0o777);
    expect(() => hostSocket(home)).toThrow("Unsafe home");
    chmodSync(home, 0o700);
    const root = join(home, ".foom-host");
    chmodSync(root, 0o755);
    expect(() => hostSocket(home)).toThrow("Unsafe host");
    chmodSync(root, 0o700);
    const file = join(home, "file");
    writeFileSync(file, "x");
    expect(() => {
      privateDirectory(file);
    }).toThrow();
    expect(() => {
      checkSocket(file);
    }).toThrow();
    const link = join(home, "link");
    symlinkSync(root, link);
    expect(() => {
      privateDirectory(link);
    }).toThrow();
    expect(() => hostSocket(link)).toThrow();
    expect(() => {
      privateDirectory(join(home, "missing/child"));
    }).toThrow();
    const long = join(home, "a".repeat(95));
    mkdirSync(long, { mode: 0o700 });
    expect(() => hostSocket(long)).toThrow("too long");
  },
);
