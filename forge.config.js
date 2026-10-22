const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");

module.exports = {
  hooks: {
    preMake: async () => {
      if (process.platform !== "win32") return;
      // pnpm disables transitive lifecycle scripts. Select only the pinned
      // winstaller's bundled host tools, without executing its install script.
      const { copyFile } = require("node:fs/promises");
      const { dirname, join } = require("node:path");
      const vendor = join(dirname(require.resolve("electron-winstaller/package.json")), "vendor");
      for (const extension of ["exe", "dll"])
        await copyFile(
          join(vendor, `7z-${process.arch}.${extension}`),
          join(vendor, `7z.${extension}`),
        );
    },
    // Sole packaging build owner, including direct Forge package/make invocations.
    // Always rebuild without --samples before copying assets into a package.
    prePackage: () => {
      require("node:child_process").execFileSync(
        process.execPath,
        [require("node:path").join(__dirname, "scripts/build.mjs")],
        { cwd: __dirname, stdio: "inherit" },
      );
    },
    // Seal the finished bundle after fuses, ASAR creation and helper copying.
    // Local/PR packages exercise the release signer with an ad-hoc identity.
    // Developer ID signing happens later on the tested ZIP, never during a build.
    postPackage: async (_config, result) => {
      if (result.platform !== "darwin") return;
      const { execFileSync } = require("node:child_process");
      for (const output of result.outputPaths) {
        const app = require("node:path").join(output, "Foom.app");
        execFileSync(process.execPath, ["scripts/macos-sign.mjs", "adhoc", app], {
          cwd: __dirname,
          stdio: "inherit",
        });
      }
    },
    // The helper is a console Node SEA, never Electron's GUI executable.
    packageAfterCopy: async (_config, buildPath) => {
      await require("node:fs/promises").rm(require("node:path").join(buildPath, "build/sea"), {
        recursive: true,
        force: true,
      });
    },
    packageAfterPrune: require("./scripts/package-conpty.cjs"),
  },
  packagerConfig: {
    asar: {
      unpack: "**/build/{observers/**/*,console/**/*,manual/!(sections.json)}",
      unpackDir: "**/node_modules/node-pty/**",
    },
    executableName: "Foom",
    appBundleId: "com.foom-term.foom",
    // Include production dependencies; native PTY binaries and helpers must live outside ASAR.
    ignore: (file) =>
      !["", "/package.json", "/LICENSE", "/NOTICE"].includes(file) &&
      !/^\/(?:build|node_modules)(?:\/|$)/.test(file),
  },
  makers: [
    { name: "@electron-forge/maker-zip", platforms: ["darwin", "linux", "win32"] },
    new (require("./scripts/maker-dmg.cjs"))(),
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: { authors: "Foom contributors", description: "Foom terminal", noMsi: true },
    },
    {
      name: "@electron-forge/maker-deb",
      platforms: ["linux"],
      config: {
        options: {
          bin: "Foom",
          desktopTemplate: require("node:path").join(__dirname, "scripts/foom.desktop.ejs"),
          maintainer: "Foom contributors",
          homepage: "https://github.com/scott-r-lindsey/foom",
        },
      },
    },
    {
      name: "@electron-forge/maker-rpm",
      platforms: ["linux"],
      config: {
        options: {
          bin: "Foom",
          desktopTemplate: require("node:path").join(__dirname, "scripts/foom.desktop.ejs"),
          homepage: "https://github.com/scott-r-lindsey/foom",
          specTemplate: require("node:path").join(__dirname, "scripts/foom-rpm.spec.ejs"),
        },
      },
    },
  ],
  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: { owner: "scott-r-lindsey", name: "foom" },
        draft: true,
        generateReleaseNotes: true,
      },
    },
  ],
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
