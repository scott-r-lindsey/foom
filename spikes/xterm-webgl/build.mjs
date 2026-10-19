// Comparison-only transform: the application source and packaged bundle stay unchanged.
import { build } from "../../node_modules/esbuild/lib/main.js";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
await build({
  entryPoints: ["src/renderer/renderer.tsx"],
  bundle: true,
  minify: true,
  platform: "browser",
  format: "esm",
  tsconfig: "tsconfig.renderer.json",
  define: {
    "process.env.NODE_ENV": '"production"',
    process: "undefined",
    FOOM_SAMPLE_BOARD: "false",
  },
  outfile: "test-results/620-webgl-renderer.js",
  plugins: [
    {
      name: "evaluation-only-webgl",
      setup(builder) {
        builder.onResolve({ filter: /^@xterm\/addon-webgl$/ }, () => ({
          path: require.resolve("@xterm/addon-webgl"),
        }));
        builder.onLoad({ filter: /shell-controller\.ts$/ }, async ({ path }) => {
          const original = await readFile(path, "utf8");
          const needle = "if (!isDisposed()) terminal.open(container);";
          if (original.split(needle).length !== 2)
            throw new Error("Controller open sequence changed; review injection");
          return {
            loader: "ts",
            contents:
              `import { WebglAddon } from '@xterm/addon-webgl';\n` +
              original.replace(
                needle,
                `if (!isDisposed()) {
        terminal.open(container);
        const addon = new WebglAddon();
        addon.onContextLoss(() => { container.dataset.webgl = 'lost'; addon.dispose(); });
        try { terminal.loadAddon(addon); container.dataset.webgl = 'active'; }
        catch (error) { container.dataset.webgl = 'failed'; container.dataset.webglError = String(error); addon.dispose(); }
      }`,
              ),
          };
        });
      },
    },
  ],
});
