import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ApplicationError, errorMessage } from "../../../../src/shared/application-errors";

const mock = vi.hoisted(() => ({
  metadata: "",
  spawn: vi.fn(() => {
    throw new Error("SSH spawn forbidden");
  }),
  execFile: vi.fn(() => {
    throw new Error("SSH discovery forbidden");
  }),
  fork: vi.fn(() => {
    throw new Error("Local utility host forbidden");
  }),
}));
vi.mock("node:child_process", () => ({ spawn: mock.spawn, execFile: mock.execFile }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>();
  return {
    ...fs,
    open: (path: string, flags: number) => {
      if (!path.endsWith("build-metadata.json")) throw new Error("Unexpected artifact read");
      return fs.open(mock.metadata, flags);
    },
  };
});
vi.mock("electron", () => ({
  app: { getVersion: () => "0.1.0" },
  utilityProcess: { fork: mock.fork },
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() },
}));
// Keep the real client, transport and bootstrap together: a transport exit alone
// must not turn the sealed omission into the generic terminal-host-stopped error.
import { TerminalHostClient } from "../../../../src/main/terminals/terminal-host-client";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  vi.clearAllMocks();
});

test.each(["omitted", "invalid"])(
  "%s package metadata refuses remote launch before any SSH",
  async (kind) => {
    root = await mkdtemp(join(tmpdir(), "remote-launch-"));
    mock.metadata = join(root, "build-metadata.json");
    await writeFile(
      mock.metadata,
      JSON.stringify({
        source: kind === "omitted" ? "a".repeat(40) : "invalid",
        remoteHostsAvailable: false,
        message: "UNTRUSTED diagnostic text",
      }),
    );
    const client = new TerminalHostClient(vi.fn());
    try {
      const launch = () =>
        client.create({
          id: "home-remote",
          command: "/fixture/shell",
          args: [],
          cwd: "/fixture",
          cols: 80,
          rows: 24,
          remote: { host: "fixture-host" },
        });
      for (let attempt = 0; attempt < 2; attempt++) {
        const result: unknown = await launch().catch((error: unknown) => error);
        expect(result).toBeInstanceOf(Error);
        {
          expect(result).toBeInstanceOf(ApplicationError);
          expect(errorMessage(result)).toBe(
            "Remote host artifact unavailable in this local build.",
          );
          // This is the same code that survives the window/workspace IPC sanitizer
          // and Electron's wrapper, then selects fixed renderer-owned copy.
          if (!(result instanceof Error)) throw new Error("Expected launch failure");
          expect(
            errorMessage(
              new Error(
                `Error invoking remote method 'workspace:sidebar-command': Error: ${result.message}`,
              ),
            ),
          ).toBe("Remote host artifact unavailable in this local build.");
        }
        expect(client.runningCount).toBe(0);
      }
      expect(mock.spawn).not.toHaveBeenCalled();
      expect(mock.execFile).not.toHaveBeenCalled();
      expect(mock.fork).not.toHaveBeenCalled();
    } finally {
      await client.dispose();
    }
  },
);
