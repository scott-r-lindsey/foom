import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, cp, glob, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkoutRevision, prepareBuildRemoteHosts } from "./remote-host-artifacts.mjs";
import { writeIcons } from "./icon/foom-icon.mjs";

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
// Trusted app metadata stays inside ASAR, separate from the unpacked host catalog.
const sourceRevision = checkoutRevision(root);
await writeFile(
  join(root, "build/build-metadata.json"),
  JSON.stringify({ source: sourceRevision }),
);
// Inline the pure board registry: the sandbox loader still requires only Electron.
await build({
  entryPoints: [join(root, "src/preload/preload.ts")],
  bundle: true,
  platform: "browser",
  format: "cjs",
  external: ["electron"],
  outfile: join(root, "build/preload/preload.js"),
});

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

// Bundle the read-only guide and project shortcuts from the compiled command registry.
const { manualShortcuts } = await import("../build/main/window/manual-shortcuts.js");
const { createCommands } = await import("../build/main/window/commands.js");
const shortcuts = ["darwin", "linux"]
  .map((platform) =>
    manualShortcuts(
      createCommands(platform, false, {
        board: () => undefined,
        native: () => undefined,
        zoom: () => Promise.resolve(),
      }),
      platform,
    ),
  )
  .join("\n");
await mkdir(join(root, "build/manual"), { recursive: true });
await copyFile(join(root, "src/manual/manual.css"), join(root, "build/manual/manual.css"));
await build({
  entryPoints: [join(root, "src/manual/search.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  outfile: join(root, "build/manual/search.js"),
});
const manual = await readFile(join(root, "src/manual/manual.html"), "utf8");
const completedManual = manual.replace("<!-- SHORTCUTS -->", shortcuts);
await writeFile(join(root, "build/manual/manual.html"), completedManual);
// Share one extraction definition with the page; future main-process consumers
// can read this bundled artifact without a DOM or a second list of section IDs.
const indexModule = join(root, "build/manual-index.cjs");
await build({
  entryPoints: [join(root, "src/manual/section-index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: indexModule,
});
const { sectionIndex } = await import("../build/manual-index.cjs");
const manualDocument = new JSDOM(completedManual);
await writeFile(
  join(root, "build/manual/sections.json"),
  `${JSON.stringify(sectionIndex(manualDocument.window.document))}\n`,
);
manualDocument.window.close();
await rm(indexModule);
for (const font of ["geist.ttf", "geist-mono.ttf"]) {
  await copyFile(join(root, "src/renderer/fonts", font), join(root, "build/manual", font));
}

// One browser-only runtime shared by every isolated Markdown preview.
await build({
  entryPoints: [join(root, "src/renderer/preview/runtime.ts")],
  bundle: true,
  minify: true,
  platform: "browser",
  format: "iife",
  outfile: join(root, "build/preview/markdown.js"),
});
await copyFile(
  join(root, "src/renderer/preview/markdown.css"),
  join(root, "build/preview/markdown.css"),
);

for (const font of ["geist.ttf", "geist-mono.ttf"]) {
  await copyFile(join(root, "src/renderer/fonts", font), join(root, "build/preview", font));
}

await cp(
  new URL("../src/renderer/fonts/", import.meta.url),
  new URL("../build/renderer/fonts/", import.meta.url),
  { recursive: true },
);

await cp(join(root, "src/renderer/art"), join(root, "build/renderer/art"), { recursive: true });

// Aggregate the complete licenses and modification notices for bundled assets and
// derived agent rules. Source reference checkouts are never packaged or read here.
const thirdPartyNotices = [
  "src/shared/terminal-theme-LICENSE.txt",
  "node_modules/markdown-it/LICENSE",
  "node_modules/smol-toml/LICENSE",
  "node_modules/sharp/LICENSE",
  "node_modules/highlight.js/LICENSE",
  "node_modules/argparse/LICENSE",
  "node_modules/entities/LICENSE",
  "node_modules/linkify-it/LICENSE",
  "node_modules/mdurl/LICENSE",
  "node_modules/punycode.js/LICENSE-MIT.txt",
  "node_modules/uc.micro/LICENSE.txt",
  "src/sounds/NOTICES.txt",
  "src/main/evaluator/agent-rules/LICENSE.txt",
];
for await (const name of glob("src/renderer/fonts/*.txt", { cwd: root })) {
  thirdPartyNotices.push(name);
}
for await (const name of glob("node_modules/@img/*/{LICENSE,README.md}", { cwd: root })) {
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
await build({
  entryPoints: [join(root, "src/renderer/styles/confirmation.css")],
  bundle: true,
  outfile: join(root, "build/renderer/confirmation.css"),
});

await cp(join(root, "src/sounds"), join(root, "build/sounds"), { recursive: true });

// Forge reads foom.icns/foom.ico and Linux windows load foom-512.png at runtime.
// Rendering takes seconds, so sets are cached by generator source hash.
await writeIcons(join(root, "build/icons"));

const { agyPluginFiles } = await import("../build/main/agents/agy-observer.js");
await mkdir(join(root, "build/observers/foom"), { recursive: true });
for (const [name, source] of Object.entries(agyPluginFiles(process.platform))) {
  await writeFile(join(root, "build/observers/foom", name), source, { mode: 0o755 });
}

// Native interpreters need real files outside ASAR, at a stable installation path.
const { bundledProviders } = await import("../build/main/agents/providers/bundled.js");
const { observerAssets } = await import("../build/main/agents/providers/v2-observers.js");
const { installedObserverPath } = await import(
  "../build/main/agents/providers/installed-observers.js"
);
await mkdir(join(root, "build/observers"), { recursive: true });
for (const provider of bundledProviders) {
  for (const channel of provider.model?.hooks?.channels ?? []) {
    if (channel.observer.placement !== "stable") continue;
    for (const windows of [false, true]) {
      for (const [name, source] of Object.entries(observerAssets(channel, windows))) {
        if (!name.startsWith("observer.")) throw new Error("Unsupported installed observer asset");
        await writeFile(
          installedObserverPath(channel, windows, join(root, "build/observers")),
          source,
          { mode: 0o755 },
        );
      }
    }
  }
}

await import("./build-cli.mjs");

// Development and packaged builds verify the same complete, exact-revision catalog.
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const remoteHostsAvailable = await prepareBuildRemoteHosts(
  process.env.FOOM_REMOTE_HOST_ARTIFACTS ?? join(root, ".cache/remote-hosts"),
  join(root, "build/remote-hosts"),
  version,
  sourceRevision,
);
await writeFile(
  join(root, "build/build-metadata.json"),
  JSON.stringify({ source: sourceRevision, remoteHostsAvailable }),
);
