import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, cp, glob, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
for (const asset of ["index.html", "confirmation.html", "tokens.css"]) {
  await copyFile(
    new URL(
      `../src/renderer/${asset.endsWith(".html") ? asset : `styles/${asset}`}`,
      import.meta.url,
    ),
    new URL(`../build/renderer/${asset}`, import.meta.url),
  );
}

// Bundle feature styles into the existing allowlisted URL; no runtime CSS imports.
await build({
  entryPoints: [fileURLToPath(new URL("../src/renderer/styles/styles.css", import.meta.url))],
  bundle: true,
  outfile: fileURLToPath(new URL("../build/renderer/styles.css", import.meta.url)),
});

await build({
  entryPoints: [fileURLToPath(new URL("../src/renderer/renderer.tsx", import.meta.url))],
  bundle: true,
  tsconfig: fileURLToPath(new URL("../tsconfig.renderer.json", import.meta.url)),
  // React and xterm contain guarded Node fallbacks; the sandbox is browser-only.
  define: {
    "process.env.NODE_ENV": '"production"',
    process: "undefined",
    FOOM_SAMPLE_BOARD: String(process.argv.includes("--samples")),
  },
  minify: true,
  platform: "browser",
  format: "esm",
  outfile: fileURLToPath(new URL("../build/renderer/renderer.js", import.meta.url)),
});

await cp(
  new URL("../src/renderer/fonts/", import.meta.url),
  new URL("../build/renderer/fonts/", import.meta.url),
  { recursive: true },
);

// Aggregate the complete licenses and modification notices for bundled assets and
// derived agent rules. Source reference checkouts are never packaged or read here.
const thirdPartyNotices = [
  "src/shared/terminal-theme-LICENSE.txt",
  "src/sounds/NOTICES.txt",
  "src/main/evaluator/agent-rules/LICENSE.txt",
];
for await (const name of glob("src/renderer/fonts/*.txt", { cwd: root })) {
  thirdPartyNotices.push(name);
}
thirdPartyNotices.sort();
await writeFile(
  join(root, "build/THIRD_PARTY_NOTICES.txt"),
  "Foom bundled third-party licenses and attributions\n\n" +
    (
      await Promise.all(
        thirdPartyNotices.map(
          async (name) => `${name}\n\n${await readFile(join(root, name), "utf8")}`,
        ),
      )
    ).join("\n\n"),
);

await build({
  entryPoints: [join(root, "src/renderer/confirmation.tsx")],
  tsconfig: join(root, "tsconfig.renderer.json"),
  bundle: true,
  define: { "process.env.NODE_ENV": '"production"' },
  minify: true,
  platform: "browser",
  format: "esm",
  outfile: join(root, "build/renderer/confirmation.js"),
});
await copyFile(
  join(root, "src/renderer/styles/confirmation.css"),
  join(root, "build/renderer/confirmation.css"),
);

await cp(join(root, "src/sounds"), join(root, "build/sounds"), { recursive: true });

// Native interpreters need real files outside ASAR, at a stable installation path.
const { codexObserverSource } = await import("../build/main/agents/codex-hooks.js");
await mkdir(join(root, "build/observers"), { recursive: true });
for (const [platform, extension] of [
  ["posix", "sh"],
  ["win32", "ps1"],
]) {
  await writeFile(
    join(root, `build/observers/codex-v1.${extension}`),
    codexObserverSource(platform),
    { mode: 0o755 },
  );
}

await import("./build-cli.mjs");
