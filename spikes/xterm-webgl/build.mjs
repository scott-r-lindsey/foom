// Comparison-only transforms. Never edits application source or production bundles.
import { build } from "../../node_modules/esbuild/lib/main.js";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
for (const renderer of ["dom", "webgl"])
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
      FOOM_EVALUATE_WEBGL: String(renderer === "webgl"),
    },
    outfile: `test-results/620-${renderer}-renderer.js`,
    plugins: [
      {
        name: "evaluation-only-renderer",
        setup(builder) {
          builder.onResolve({ filter: /^@xterm\/addon-webgl$/ }, () => ({
            path: require.resolve("@xterm/addon-webgl"),
          }));
          builder.onLoad({ filter: /shell-controller\.ts$/ }, async ({ path: file }) => {
            let contents = await readFile(file, "utf8");
            const replace = (needle, value) => {
              if (contents.split(needle).length !== 2)
                throw new Error(`Controller changed: ${needle}`);
              contents = contents.replace(needle, value);
            };
            replace(
              "  const isDisposed = () => disposed;",
              "  const isDisposed = () => disposed;\n  const evaluation = track(terminal, container, () => activeId, fit);",
            );
            replace(
              "    attached = visible;",
              "    attached = visible;\n    evaluationVisibility(evaluation, visible);",
            );
            replace(
              "    terminal.dispose();",
              "    evaluationDispose(evaluation);\n    terminal.dispose();",
            );
            replace(
              "    // Drain writes from the old attachment",
              "    evaluationEvent(evaluation, 'drain');\n    // Drain writes from the old attachment",
            );
            replace(
              "    fit.fit();\n    view.cols",
              "    fit.fit();\n    evaluationEvent(evaluation, 'fit');\n    view.cols",
            );
            replace(
              "    await window.desktop.attach(id);",
              "    evaluationEvent(evaluation, 'attach:' + id);\n    await window.desktop.attach(id);\n    evaluationEvent(evaluation, 'attached:' + id);",
            );
            replace(
              "    if (id !== activeId || !attached) return;",
              "    if (id !== activeId || !attached) return;\n    evaluationEvent(evaluation, 'data:' + id);",
            );
            return {
              loader: "ts",
              contents:
                `import { track, visibility as evaluationVisibility, dispose as evaluationDispose, event as evaluationEvent } from ${JSON.stringify(path.resolve("spikes/xterm-webgl/instrument.ts"))};\n` +
                contents,
            };
          });
        },
      },
    ],
  });
