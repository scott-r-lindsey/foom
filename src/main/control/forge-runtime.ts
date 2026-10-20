import type { Settings } from "../../shared/setup";
import type { LoadedForgeManifest } from "../config/plugins";
import type { ForgeProviderFactory } from "./forge.d";
import { forgeRemote } from "./forge-mapping";
import { ForgeLifecycle } from "./forge-lifecycle";
import { githubManifest } from "./forge-manifests";
import type { ForgeLifecycleOptions } from "./forge-lifecycle-types";

const bundled: LoadedForgeManifest = {
  manifest: githubManifest,
  digest: "2b8b1fcb3983177334cb0c37ebf6cbd1588d73d0672ca043dc82c317de3892cb",
  validate: () => Promise.resolve(),
};

/** Main-owned manifest selection; routing authority comes only from profile assignments. */
export class ForgeRuntime {
  private plugins: readonly LoadedForgeManifest[] = [bundled];
  private lifecycle: ForgeLifecycle | undefined;
  private path: string | undefined;
  private revision = 0;
  private readonly retiring = new Set<Promise<void>>();
  private preferences = "";
  private closed = false;
  onInvalidate?: () => void;

  constructor(
    private readonly settings: () => Pick<Settings, "forges" | "forgeHosts">,
    private readonly discoverPath: () => Promise<string>,
    private readonly options: Omit<ForgeLifecycleOptions, "path"> = {},
  ) {}

  replace(plugins: readonly LoadedForgeManifest[]): void {
    const next = [bundled, ...plugins];
    if (next.length === this.plugins.length && next.every((p, i) => p === this.plugins[i])) return;
    if (new Set(next.map((p) => p.manifest.id)).size !== next.length)
      throw new Error("Duplicate forge ID");
    this.plugins = next;
    this.invalidate();
    this.lifecycle?.replace(next);
  }

  configure(): void {
    const { forges, forgeHosts } = this.settings();
    const next = JSON.stringify([Object.entries(forges).sort(), Object.entries(forgeHosts).sort()]);
    if (this.preferences === next) return;
    const initialized = this.preferences !== "";
    this.preferences = next;
    if (initialized) this.invalidate();
  }

  invalidate(): void {
    this.revision++;
    this.lifecycle?.invalidate();
    // Shutdown still retires work, but must not publish into crashed/disposed boards.
    if (!this.closed) this.onInvalidate?.();
  }

  readonly provider: ForgeProviderFactory = async (url, getContext) => {
    if (this.closed) return undefined;
    this.configure();
    const parsed = forgeRemote(url, "nested");
    if (!parsed || !getContext) return undefined;
    const settings = this.settings();
    const id = settings.forgeHosts[parsed.host];
    const plugin = this.plugins.find((p) => p.manifest.id === id);
    if (!plugin || settings.forges[plugin.manifest.id] !== true) return undefined;
    const remote = forgeRemote(url, plugin.manifest.remote.namespace);
    if (!remote) return undefined;
    let revision = this.revision;
    const context = await getContext().catch(() => undefined);
    if (!context) return undefined;
    const path = await this.discoverPath().catch(() => undefined);
    if (path === undefined) return undefined;
    if (revision !== this.revision) return undefined;
    if (path !== this.path) {
      if (this.path !== undefined) this.invalidate();
      revision = this.revision;
      this.path = path;
      // A PATH refresh retires cached executable identities and pending commands.
      const previous = this.lifecycle;
      this.lifecycle = undefined;
      const retiring = previous?.close();
      if (retiring) this.retiring.add(retiring);
      try {
        await retiring;
      } finally {
        if (retiring) this.retiring.delete(retiring);
      }
      if (revision !== this.revision) {
        this.path = undefined;
        return undefined;
      }
      this.lifecycle = new ForgeLifecycle({ cacheMs: 0, ...this.options, path });
      this.lifecycle.replace(this.plugins);
    }
    const lifecycle = this.lifecycle;
    if (!lifecycle) return undefined;
    const provider = lifecycle.provider({
      plugin,
      remote,
      context: {
        identity: context.identity,
        validate: async (branches) => {
          this.configure();
          if (this.closed || revision !== this.revision || lifecycle !== this.lifecycle)
            throw new Error("Forge selection changed");
          await context.validate(branches);
        },
      },
    });
    provider.binding = JSON.stringify([plugin.manifest.id, plugin.digest, remote]);
    provider.acceptLegacyBinding = plugin === bundled && remote.host === "github.com";
    if (!plugin.manifest.operations.batchStatus) delete provider.batch;
    return provider;
  };

  /** Neutral host-only auth preflight. The placeholder project is never sent to the CLI. */
  async available(): Promise<boolean> {
    for (const host of Object.keys(this.settings().forgeHosts)) {
      const provider = await this.provider(`https://${host}/foom/auth`, () =>
        Promise.resolve({
          identity: `auth:${host}`,
          validate: () => Promise.resolve(),
        }),
      );
      if (await provider?.available?.()) return true;
    }
    return false;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.invalidate();
    await Promise.all([...this.retiring, this.lifecycle?.close()]);
  }
}
