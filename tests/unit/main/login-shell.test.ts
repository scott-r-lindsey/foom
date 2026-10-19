import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { readLoginShell } from "../../../src/main/login-shell";

const run = promisify(execFile);
let directory = "";
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), "foom-login-shell-"));
  const shell = join(directory, "fixture-shell");
  const rc = join(directory, "rc");
  await writeFile(rc, "# Isolated interactive startup\n");
  await writeFile(
    shell,
    `#!/bin/sh\nexec /bin/bash --noprofile --norc -ilc '. "$HOME/rc"; eval "$1"' fixture "$2"\n`,
    { mode: 0o700 },
  );
  return {
    shell,
    options: {
      encoding: "utf8" as const,
      cwd: directory,
      env: { HOME: directory, PATH: "/usr/bin:/bin" },
      timeout: 5000,
      maxBuffer: 256 * 1024,
    },
  };
}

it.skipIf(process.platform === "win32")(
  "concurrent interactive reads never stop the foreground PTY process group",
  async () => {
    const { shell, options } = await fixture();
    await writeFile(
      join(directory, "rc"),
      'printf "%s\\n" "$$" >> "$HOME/ready"\nwhile [ ! -f "$HOME/release" ]; do /bin/sleep 0.01; done\n',
    );
    const bundled = join(directory, "reader.cjs");
    await build({
      entryPoints: ["src/main/login-shell.ts"],
      outfile: bundled,
      bundle: true,
      platform: "node",
      format: "cjs",
    });
    const pty = await import("node-pty");
    const terminal = pty.spawn(
      "/bin/bash",
      [
        "--noprofile",
        "--norc",
        "-ic",
        '"$1" "$2" "$3" "$4"; result=$?; if [ "$result" -eq 0 ]; then exit 0; fi; read -r unused',
        "supervisor",
        process.execPath,
        resolve("tests/fixtures/login-shell/foreground.js"),
        bundled,
        shell,
      ],
      { cwd: directory, env: options.env },
    );
    let output = "";
    const state = { exited: false };
    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit(() => {
      state.exited = true;
    });
    const pids = new Set<number>([terminal.pid]);
    let stopped = "";
    try {
      const deadline = Date.now() + 10000;
      while (!state.exited && Date.now() < deadline) {
        const { stdout } = await run("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat="], {
          env: options.env,
        });
        const rows = stdout
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/));
        // Include descendants that bash moved into their own job-control groups.
        for (let pass = 0; pass < rows.length; pass++) {
          for (const [pid, parent] of rows) if (pids.has(Number(parent))) pids.add(Number(pid));
        }
        stopped = rows
          .filter(([pid, , , state]) => pids.has(Number(pid)) && state?.includes("T"))
          .map((row) => row.join(" "))
          .join("\n");
        if (stopped) break;
        await new Promise((resolvePoll) => setTimeout(resolvePoll, 10));
      }
      expect(stopped, `stopped processes; output=${output}`).toBe("");
      expect(output).not.toContain("Stopped");
      expect(output).toContain("READY:");
      expect(output).toContain("COMPLETE");
      expect(state.exited).toBe(true);
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
      terminal.kill("SIGKILL");
    }
  },
);

it.skipIf(process.platform === "win32")(
  "preserves output and rejects shell failures and missing executables",
  async () => {
    const { shell, options } = await fixture();
    expect(
      await readLoginShell(shell, ["-ilc", "printf 'a\\000b'; printf err >&2"], options),
    ).toMatchObject({ stdout: "a\0b" });
    await expect(readLoginShell(shell, ["-ilc", "exit 3"], options)).rejects.toThrow("failed");
    await expect(readLoginShell(join(directory, "absent"), [], options)).rejects.toThrow();
  },
);

it.skipIf(process.platform === "win32").each(["timeout", "stdout", "stderr", "exit"])(
  "kills the detached shell and descendants on %s",
  async (mode) => {
    const { shell, options } = await fixture();
    // Disable job control so the stubborn grandchild stays in the detached read's group.
    const program = `set +m; trap '' TERM; /bin/sh -c 'trap "" TERM; echo $$ > "$HOME/descendant"; while :; do :; done' & echo $$ > "$HOME/parent"; while [ ! -f "$HOME/descendant" ]; do /bin/sleep 0.01; done; ${mode === "exit" ? "exit 0" : mode === "timeout" ? "wait" : `while :; do printf 'too much output\\n' ${mode === "stderr" ? ">&2" : ""}; done`}`;
    const result = readLoginShell(shell, ["-ilc", program], {
      ...options,
      timeout: mode === "timeout" ? 200 : 5000,
      maxBuffer: 4096,
    });
    if (mode === "exit") await expect(result).resolves.toMatchObject({ stdout: "" });
    else await expect(result).rejects.toThrow(mode === "timeout" ? "timed out" : "output limit");
    for (const name of ["parent", "descendant"]) {
      const pid = Number(await readFile(join(directory, name), "utf8"));
      // A dead orphan can briefly remain a zombie until the OS reaps it.
      const { stdout } = await run("/bin/ps", ["-axo", "pid=,stat="], { env: options.env });
      expect(
        stdout
          .trim()
          .split("\n")
          .some((line) => {
            const [id, state] = line.trim().split(/\s+/);
            return Number(id) === pid && !state?.startsWith("Z");
          }),
      ).toBe(false);
    }
  },
);

it("bounds reads and reports output, exit and spawn errors on every platform", async () => {
  directory = await mkdtemp(join(tmpdir(), "foom-login-node-"));
  const options = { encoding: "utf8" as const, cwd: directory, timeout: 5000, maxBuffer: 4096 };
  expect(
    await readLoginShell(
      process.execPath,
      ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      options,
    ),
  ).toEqual({ stdout: "out", stderr: "err" });
  await expect(
    readLoginShell(process.execPath, ["-e", "process.exit(2)"], options),
  ).rejects.toThrow("failed");
  await expect(readLoginShell(join(directory, "missing"), [], options)).rejects.toThrow();
  await expect(
    readLoginShell(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      ...options,
      timeout: 100,
    }),
  ).rejects.toThrow("timed out");
  for (const stream of ["stdout", "stderr"]) {
    await expect(
      readLoginShell(
        process.execPath,
        ["-e", `process.${stream}.write('x'.repeat(8192))`],
        options,
      ),
    ).rejects.toThrow("output limit");
  }
});
