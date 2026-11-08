import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export interface VendorScript {
  url: string;
  interpreter: "sh" | "bash";
  arguments: readonly string[];
}

/** HTTPS applies to every hop. The response is bounded before any byte is executed. */
export async function downloadVendorScript(
  address: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<Uint8Array> {
  let url = new URL(address);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error("Installer requires HTTPS");
    const response = await request(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Installer redirect missing address");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("Installer download failed");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 2 * 1024 * 1024) throw new Error("Installer download too large");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    if (!size) throw new Error("Installer download empty");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  throw new Error("Too many installer redirects");
}

/** Only invoked by a human-owned recipe process, without Foom credentials. */
export async function runVendorScript(
  script: VendorScript,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  process.stdout.write(`Download ${script.url}\n`);
  const abort = new AbortController();
  const stop = () => {
    abort.abort();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let directory: string | undefined;
  try {
    const bytes = await downloadVendorScript(
      script.url,
      AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
    );
    abort.signal.throwIfAborted();
    directory = await mkdtemp(join(tmpdir(), "foom-installer-"));
    const path = join(directory, "install.sh");
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    abort.signal.throwIfAborted();
    return await new Promise<number>((resolve) => {
      const child = spawn(`/bin/${script.interpreter}`, [path, ...script.arguments], {
        cwd: home,
        env,
        shell: false,
        stdio: "inherit",
        signal: abort.signal,
      });
      let failed = false;
      child.once("error", () => {
        failed = true;
      });
      child.once("close", (code) => {
        resolve(failed ? 1 : (code ?? 1));
      });
    });
  } catch {
    process.stderr.write("Installer download or execution failed\n");
    return 1;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
