const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");

module.exports = {
  hooks: {
    // Rebuild without the development flag before copying assets into a package.
    prePackage: () => {
      require("node:child_process").execFileSync(
        process.execPath,
        [require("node:path").join(__dirname, "scripts/build.mjs")],
        { cwd: __dirname, stdio: "inherit" },
      );
    },
    packageAfterPrune: require("./scripts/package-conpty.cjs"),
  },
  packagerConfig: {
    asar: { unpack: "**/build/observers/**/*", unpackDir: "**/node_modules/node-pty/**" },
    executableName: "foom",
    appBundleId: "com.foom.desktop",
    // Include production dependencies; native PTY binaries and helpers must live outside ASAR.
    ignore: (file) =>
      !["", "/package.json", "/LICENSE", "/NOTICE"].includes(file) &&
      !/^\/(?:build|node_modules)(?:\/|$)/.test(file),
  },
  makers: [{ name: "@electron-forge/maker-zip", platforms: ["darwin", "linux", "win32"] }],
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
