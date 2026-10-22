import { createHash } from "node:crypto";
import gitlab from "../../shared/bundled-forges/gitlab.json";
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
  "2b8b1fcb3983177334cb0c37ebf6cbd1588d73d0672ca043dc82c317de3892cb",
);

export const gitlabManifest = bundledForge(
  gitlab,
  "gitlab",
  "4a9367675596445af47426677f5b939c751b00662eaf8e308c7af8815bb12fdc",
);
export const bundledForgeManifests = [githubManifest, gitlabManifest];
export const bundledForgeEntries = [
  {
    manifest: githubManifest,
    digest: "2b8b1fcb3983177334cb0c37ebf6cbd1588d73d0672ca043dc82c317de3892cb",
  },
  {
    manifest: gitlabManifest,
    digest: "4a9367675596445af47426677f5b939c751b00662eaf8e308c7af8815bb12fdc",
  },
];
