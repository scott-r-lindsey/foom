const { access, copyFile, mkdir } = require("node:fs/promises");
const { join } = require("node:path");

// electron-rebuild runs node-gyp rebuild, which clears build/Release without
// rerunning node-pty's postinstall. Its rebuilt conpty.node loads this sibling
// directory at runtime; the copies shipped beside the prebuild cannot serve it.
module.exports = async function packageConpty(_config, buildPath, _version, platform, arch) {
  if (platform !== "win32") return;
  const root = join(buildPath, "node_modules", "node-pty");
  const release = join(root, "build", "Release");
  try {
    await access(join(release, "conpty.node"));
  } catch (error) {
    // No source rebuild: the prebuilt addon already has its adjacent support files.
    if (error.code === "ENOENT") return;
    throw error;
  }
  const destination = join(release, "conpty");
  await mkdir(destination, { recursive: true });
  for (const file of ["conpty.dll", "OpenConsole.exe"]) {
    await copyFile(
      join(root, "prebuilds", `win32-${arch}`, "conpty", file),
      join(destination, file),
    );
  }
};
