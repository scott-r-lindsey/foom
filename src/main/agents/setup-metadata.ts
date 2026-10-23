import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { manifestJson } from "../../shared/agent-manifest-json";
import type { ManifestSelector } from "../../shared/agent-manifest-v2";

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function select(
  field: ManifestSelector,
  sources: Readonly<Record<string, unknown>>,
): unknown {
  let value = sources[field.source];
  for (const key of field.path) {
    if ((!record(value) && !Array.isArray(value)) || !Object.hasOwn(value, key)) return undefined;
    value = Reflect.get(value, key);
  }
  return value;
}
function missing(error: unknown): boolean {
  return record(error) && error["code"] === "ENOENT";
}
/** Snapshot every component below the fixed home root. Links and non-directories fail closed. */
export async function metadataIdentity(
  home: string,
  relative: string,
  directory: boolean,
): Promise<string | undefined> {
  const components = relative.split("/");
  const identities: string[] = [];
  let path = home;
  for (const [index, component] of components.entries()) {
    path = join(path, component);
    const info = await lstat(path).catch((error: unknown) => {
      if (missing(error)) return undefined;
      throw error;
    });
    if (!info) return undefined;
    const folder = directory || index < components.length - 1;
    if (
      info.isSymbolicLink() ||
      (folder ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
    )
      throw new Error("Unsafe setup metadata");
    identities.push(JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]));
  }
  return identities.join("/");
}
/** Only called with parser-validated fixed plugin/config paths; never exposed as file IPC. */
export async function readSetupMetadata(home: string, relative: string): Promise<unknown> {
  const content = await readSetupFile(home, relative, 65536);
  return content === undefined ? undefined : manifestJson(content);
}

/** Fixed setup metadata/generated inventory only; never CLI-reported paths. */
export async function readSetupFile(
  home: string,
  relative: string,
  limit: number,
): Promise<string | undefined> {
  const before = await metadataIdentity(home, relative, false);
  if (before === undefined) return undefined;
  const file = await open(
    join(home, relative),
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > limit)
      throw new Error("Invalid setup metadata");
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new Error("Invalid setup metadata");
    const opened = JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
    if (!before.endsWith(opened) || before !== (await metadataIdentity(home, relative, false)))
      throw new Error("Setup metadata changed");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}
