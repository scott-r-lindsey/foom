// Build the same production renderer with an external map for offline profiling.
// Run pnpm run build first; this does not change application sources or policy.
import { build } from "esbuild";
await build({
  entryPoints: ["src/renderer/renderer.tsx"],
  bundle: true,
  tsconfig: "tsconfig.renderer.json",
  define: {
    "process.env.NODE_ENV": '"production"',
    process: "undefined",
    FOOM_SAMPLE_BOARD: "false",
  },
  minify: true,
  platform: "browser",
  format: "esm",
  sourcemap: "external",
  outfile: "build/renderer/renderer.js",
});
