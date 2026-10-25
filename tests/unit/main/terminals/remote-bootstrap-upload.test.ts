import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { bootstrapArguments } from "../../../../src/main/terminals/remote-bootstrap";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")(
  "gzip bootstrap checks platform, size, hash and cache, preserves protocol bytes, and cleans failed uploads",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bootstrap-upload-")));
    roots.push(root);
    const bin = join(root, "bin");
    const home = join(root, "home");
    await mkdir(bin, { mode: 0o700 });
    await mkdir(home, { mode: 0o700 });
    for (const tool of [
      "sh",
      "head",
      "mkdir",
      "chmod",
      "mv",
      "mktemp",
      "cut",
      "wc",
      "tr",
      "rm",
      "ls",
      "gzip",
      process.platform === "darwin" ? "shasum" : "sha256sum",
    ])
      for (const directory of ["/usr/bin", "/bin"]) {
        try {
          await stat(join(directory, tool));
          await symlink(join(directory, tool), join(bin, tool));
          break;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
            throw error;
        }
      }
    const uname = join(bin, "uname");
    await writeFile(uname, '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n', {
      mode: 0o700,
    });
    const bytes = Buffer.from("#!/bin/sh\nprintf 'EXECUTED:'\nhead -c 4\n");
    const compressed = gzipSync(bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const args = bootstrapArguments(
      "fixture",
      "0.1.0",
      hash,
      bytes.length,
      compressed.length,
      "linux",
      "x64",
    );
    const script = args.at(-1);
    if (!script) throw new Error("missing bootstrap script");
    const run = (input: Buffer) =>
      spawnSync("/bin/sh", ["-c", `sh -c ${script}`], {
        env: { PATH: bin, HOME: home, LANG: "C" },
        input,
        encoding: "utf8",
        timeout: 5000,
      });
    const cache = join(home, ".foom-host/0.1.0", hash);
    const installed = join(cache, "foom-host");
    const upload = run(Buffer.concat([compressed, Buffer.from("PING")]));
    expect(upload.status, upload.stderr).toBe(0);
    expect(upload.stdout).toBe("FOOM-UPLOAD\nFOOM-READY\nEXECUTED:PING");
    expect(await readFile(installed)).toEqual(bytes);
    const cached = run(Buffer.from("PING"));
    expect(cached.status, cached.stderr).toBe(0);
    expect(cached.stdout).toBe("FOOM-READY\nEXECUTED:PING");
    // Cached corruption cannot be executed. Invalid/truncated/wrong-hash gzip must
    // never replace it or leave a temporary upload behind.
    await writeFile(installed, "corrupt cache");
    for (const input of [
      Buffer.from("invalid gzip"),
      compressed.subarray(0, compressed.length - 1),
      gzipSync(Buffer.alloc(bytes.length, 65)),
    ]) {
      const result = run(input);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("FOOM-UPLOAD\n");
      expect(await readFile(installed, "utf8")).toBe("corrupt cache");
      expect(await readdir(cache)).toEqual(["foom-host"]);
    }
    expect(run(Buffer.concat([compressed, Buffer.from("PING")])).status).toBe(0);
    await writeFile(uname, "#!/bin/sh\necho unsupported\n", { mode: 0o700 });
    const mismatch = run(Buffer.from("PING"));
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stdout).toBe("");
  },
);
