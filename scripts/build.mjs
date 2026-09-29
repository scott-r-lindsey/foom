import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, glob, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// node-pty 1.1.0 publishes macOS spawn helpers without executable permission.
// Normalize the prebuilds before development launches and before Forge copies them.
// https://github.com/microsoft/node-pty/issues/850
if (process.platform === "darwin") {
  for await (const helper of glob("node_modules/node-pty/prebuilds/darwin-*/spawn-helper", {
    cwd: root,
  })) {
    await chmod(join(root, helper), 0o755);
  }
}
const compiler = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
await rm(new URL("../build/", import.meta.url), { recursive: true, force: true });
for (const config of ["tsconfig.main.json", "tsconfig.renderer.json"]) {
  execFileSync(process.execPath, [compiler, "-p", config], { cwd: root, stdio: "inherit" });
}
await mkdir(new URL("../build/renderer/", import.meta.url), { recursive: true });
for (const asset of ["index.html", "styles.css"]) {
  await copyFile(
    new URL(`../src/renderer/${asset}`, import.meta.url),
    new URL(`../build/renderer/${asset}`, import.meta.url),
  );
}

await build({
  entryPoints: [fileURLToPath(new URL("../src/renderer/renderer.ts", import.meta.url))],
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: fileURLToPath(new URL("../build/renderer/renderer.js", import.meta.url)),
});
