const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'foom',
    appBundleId: 'com.foom.desktop',
    ignore: [/^\/src(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/tsconfig.*\.json$/, /^\/test(?:\/|$)/, /^\/eslint\.config\.mjs$/, /^\/README\.md$/],
  },
  makers: [{ name: '@electron-forge/maker-zip', platforms: ['darwin', 'linux', 'win32'] }],
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
