import { build } from "esbuild";
import { recordBuildInput, recordBundleInputs } from "./build-inputs.mjs";

export async function bundleBuild(options) {
  if (!process.env.FOOM_BUILD_INPUTS) return build(options);
  for (const entry of options.entryPoints) recordBuildInput(entry);
  const started = Date.now();
  const result = await build({ ...options, metafile: true });
  recordBundleInputs(result.metafile, started, options.tsconfig);
  return result;
}
