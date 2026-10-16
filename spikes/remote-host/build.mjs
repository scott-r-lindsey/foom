// Research-only linux-x64 SEA. No package/lockfile or installed module edits.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
const out = resolve(process.argv[2]);
if (process.platform !== "linux" || process.arch !== "x64" || process.versions.node !== "24.17.0")
  throw Error("requires Linux x64 Node 24.17.0");
mkdirSync(out, { recursive: true, mode: 0o700 });
await build({
  entryPoints: ["spikes/remote-host/host.cjs"],
  outfile: `${out}/host.cjs`,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  plugins: [
    {
      name: "sea-native",
      setup(b) {
        b.onLoad({ filter: /node-pty\/lib\/utils\.js$/ }, () => ({
          contents: `
      const fs = require('node:fs'), crypto = require('node:crypto'), sea = require('node:sea');
      exports.assign = Object.assign;
      exports.loadNativeModule = () => {
        const bytes = Buffer.from(sea.getAsset('pty.node'));
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        const dir = process.env.LAB + '/native';
        fs.mkdirSync(dir, {recursive:true, mode:448});
        const path = dir + '/' + hash + '.node';
        try { fs.writeFileSync(path, bytes, {flag:'wx', mode:384}); } catch(e) { if(e.code !== 'EEXIST') throw e; }
        const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const st = fs.fstatSync(fd);
        const actual = crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex'); fs.closeSync(fd);
        if(!st.isFile() || st.uid !== process.getuid() || (st.mode & 63) || actual !== hash) throw Error('unsafe native cache');
        const m = {exports:{}}; process.dlopen(m, path); return {dir, module:m.exports};
      };`,
        }));
      },
    },
  ],
});
writeFileSync(
  `${out}/sea.json`,
  JSON.stringify({
    main: `${out}/host.cjs`,
    output: `${out}/host.blob`,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgvExtension: "none",
    assets: { "pty.node": resolve("node_modules/node-pty/prebuilds/linux-x64/pty.node") },
  }),
);
execFileSync(process.execPath, ["--experimental-sea-config", `${out}/sea.json`]);
copyFileSync(process.execPath, `${out}/foom-host`);
chmodSync(`${out}/foom-host`, 0o755);
execFileSync(
  process.execPath,
  [
    "node_modules/postject/dist/cli.js",
    `${out}/foom-host`,
    "NODE_SEA_BLOB",
    `${out}/host.blob`,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ],
  { stdio: "pipe" },
);
const bytes = readFileSync(`${out}/foom-host`),
  gz = gzipSync(bytes, { level: 9 });
writeFileSync(`${out}/foom-host.gz`, gz);
const result = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  raw: bytes.length,
  gzip9: gz.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  addon: readFileSync("node_modules/node-pty/prebuilds/linux-x64/pty.node").length,
};
writeFileSync(`${out}/size.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
