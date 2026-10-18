import type { ForgeManifest } from "../../shared/forge-plugin";
export interface LoadedForgeManifest {
  manifest: ForgeManifest;
  digest: string;
  validate(): Promise<void>;
}
