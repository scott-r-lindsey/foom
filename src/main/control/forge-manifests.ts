import { createHash } from "node:crypto";
import github from "../../shared/bundled-forges/github.json";
import { parsePluginManifest } from "../../shared/plugin-parser";

/** Build-owned identity and digest. Config copies use the identical parser/interpreter. */
export function bundledForge(data: unknown, id: string, digest: string) {
  const source = JSON.stringify(data);
  if (createHash("sha256").update(source).digest("hex") !== digest)
    throw new Error("Bundled forge manifest integrity mismatch");
  const loaded = parsePluginManifest(source, "bundled");
  if (loaded.kind !== "forge" || loaded.plugin.id !== id)
    throw new Error("Invalid bundled forge manifest identity");
  return loaded.plugin;
}
export const githubManifest = bundledForge(
  github,
  "github",
  "3bac77a68c8d09bac7b93d26435b0543c67c26db06be9e686e842681315266aa",
);
