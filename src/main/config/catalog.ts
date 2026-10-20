import { readdir } from "node:fs/promises";
import { parsePluginManifest } from "../../shared/plugin-parser";
import { AgentManifestError } from "../../shared/agent-manifest";
import { v2Provider } from "../agents/providers/v2";
import type { AgentProvider } from "../agents/providers/registry";
import type { LoadedForgeManifest } from "./plugins";
import type { ConfigServiceDependencies } from "./service";
import { decode, settle } from "./files";
import type { ConfigFiles } from "./files";
import { digest, THEME_FOLDERS } from "./layout";

import { validThemeFile } from "../../shared/theme-validation";

const MAX_THEMES = 50;

type LoadedPlugin = { text: string } & (
  | { kind: "agent"; provider: AgentProvider }
  | { kind: "forge"; forge: LoadedForgeManifest }
);

/** Theme paths and plugin manifests; catalog loading grants no launch authority. */
export class ConfigCatalog {
  readonly loadedPlugins = new Map<string, LoadedPlugin>();
  constructor(
    private readonly files: ConfigFiles,
    private readonly rejected: Map<string, { object: string; reason: string }>,
    private readonly closed: () => boolean,
    private readonly deps: Pick<ConfigServiceDependencies, "applyForges" | "applyPlugins">,
  ) {}

  /** At most 50 eligible names per theme folder, sorted. */
  async themePaths(): Promise<string[]> {
    const paths: string[] = [];
    for (const folder of Object.values(THEME_FOLDERS)) {
      if (!(await this.files.contained(folder))) continue;
      const names = await settle(readdir(this.files.path(folder)), [] as string[]);
      paths.push(
        ...names
          .filter((name) => validThemeFile(name))
          .sort()
          .slice(0, MAX_THEMES)
          .map((name) => `${folder}/${name}`),
      );
    }
    return paths;
  }

  private async pluginPaths(): Promise<string[]> {
    const paths: string[] = [];
    for (const folder of ["agents", "forges"]) {
      if (!(await this.files.contained(folder))) continue;
      const names = await readdir(this.files.path(folder)).catch(() => []);
      paths.push(
        ...names
          .filter((name) => /^[a-z][a-z0-9-]{0,39}\.json$/u.test(name))
          .sort()
          .slice(0, 50)
          .map((name) => `${folder}/${name}`),
      );
    }
    return paths;
  }

  /** A valid manifest loads as read; an edit reloads it and an invalid file is rejected whole. */
  async scanPlugins(): Promise<void> {
    const eligible = new Set(await this.pluginPaths());
    const paths = new Set([
      ...eligible,
      ...this.loadedPlugins.keys(),
      ...[...this.rejected.keys()].filter(
        (file) => file.startsWith("agents/") || file.startsWith("forges/"),
      ),
    ]);
    const active: AgentProvider[] = [];
    const forges: LoadedForgeManifest[] = [];
    for (const file of paths) {
      if (!eligible.has(file)) {
        this.loadedPlugins.delete(file);
        this.rejected.delete(file);
        continue;
      }
      let bytes: Buffer | null;
      try {
        bytes = await this.files.read(file);
      } catch {
        this.loadedPlugins.delete(file);
        this.rejected.set(file, { object: "unreadable", reason: "$: unsafe-file" });
        continue;
      }
      if (!bytes) {
        this.loadedPlugins.delete(file);
        this.rejected.delete(file);
        continue;
      }
      let text: string;
      let loaded: ReturnType<typeof parsePluginManifest>;
      try {
        text = decode(bytes);
        loaded = parsePluginManifest(text);
        const folder = loaded.kind === "agent" ? "agents" : "forges";
        if (!file.startsWith(`${folder}/`)) throw new AgentManifestError("$", "invalid-kind");
        const identifier = loaded.kind === "agent" ? loaded.plugin.model.id : loaded.plugin.id;
        if (file !== `${folder}/${identifier}.json`)
          throw new AgentManifestError("$.id", "filename-mismatch");
      } catch (error) {
        this.loadedPlugins.delete(file);
        this.rejected.set(file, {
          object: digest(bytes),
          reason: error instanceof AgentManifestError ? error.message : "$: invalid-manifest",
        });
        continue;
      }
      this.rejected.delete(file);
      const hash = digest(bytes);
      const previous = this.loadedPlugins.get(file);
      // A launch/sample binds the bytes it was offered; edits wait for the next scan.
      const validate = async () => {
        const current = await this.files.read(file);
        if (
          this.closed() ||
          this.loadedPlugins.get(file) !== entry ||
          !current ||
          digest(current) !== hash
        )
          throw new Error("Agent or forge plugin changed. Try again.");
      };
      let entry: LoadedPlugin;
      if (previous?.text === text) entry = previous;
      else if (loaded.kind === "agent")
        entry = {
          kind: "agent",
          text,
          provider: v2Provider(loaded.plugin.model, validate),
        };
      else
        entry = { kind: "forge", text, forge: { manifest: loaded.plugin, digest: hash, validate } };
      this.loadedPlugins.set(file, entry);
      if (entry.kind === "agent") active.push(entry.provider);
      else forges.push(entry.forge);
    }
    this.deps.applyForges?.(forges);
    this.deps.applyPlugins?.(active);
  }
}
