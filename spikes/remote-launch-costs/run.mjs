// Linux fixture-only bootstrap/connector profile. No system ssh or real agents.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

assert.equal(process.platform, "linux");
assert.equal(process.versions.node.split(".")[0], "24");
const root = resolve(".");
const out = resolve("test-results/1098");
await mkdir(out, { recursive: true });
const require = createRequire(import.meta.url);
const now = () => performance.timeOrigin + performance.now();
const results = { node: process.version, platform: process.platform, arch: process.arch, runs: [] };
// Build a private copy of the production builder, adding only test instrumentation.
// This retains the production native loader, SEA options and manifest generation.
let builder = await readFile("scripts/build-remote-host.mjs", "utf8");
for (const anchor of [
  'fileURLToPath(new URL("../", import.meta.url))',
  "plugins: [",
  '"./remote-host-artifacts.mjs"',
  '"./remote-host-darwin.mjs"',
])
  assert.ok(builder.includes(anchor), `Production builder anchor changed: ${anchor}`);
for (const name of ["remote-host-artifacts", "remote-host-darwin"])
  builder = builder.replace(
    `"./${name}.mjs"`,
    JSON.stringify(pathToFileURL(resolve(`scripts/${name}.mjs`)).href),
  );
builder = builder.replace('fileURLToPath(new URL("../", import.meta.url))', JSON.stringify(root));
builder = builder.replace(
  "plugins: [",
  'plugins: [instrumentation(process.env.FOOM_COST_BASELINE === "1"),',
);
builder = `import { instrumentation } from ${JSON.stringify(pathToFileURL(resolve("spikes/remote-launch-costs/instrument.mjs")).href)};\n${builder}`;
const builderPath = join(out, "build-profile.mjs");
await writeFile(builderPath, builder);

await build({
  stdin: {
    contents:
      'export {selectHostArtifact} from "./src/main/terminals/remote-bootstrap"; export {RemoteFrames,remoteFrame,remoteResponse,remoteRequest} from "./src/shared/remote-host-protocol";',
    resolveDir: root,
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: join(out, "client.cjs"),
  plugins: [
    {
      name: "artifact-timing",
      setup(api) {
        api.onLoad({ filter: /remote-bootstrap\.ts$/ }, async ({ path }) => {
          let source = await readFile(path, "utf8");
          source = source.replace(
            "export async function hostArtifact(",
            "async function measuredArtifact(",
          );
          source +=
            '\nasync function hostArtifact(...args: Parameters<typeof measuredArtifact>) { globalThis.cost1098("local-hash-start"); try { return await measuredArtifact(...args); } finally { globalThis.cost1098("local-hash-end"); } }';
          return { contents: source, loader: "ts" };
        });
      },
    },
  ],
});
await build({
  entryPoints: ["src/main/terminals/remote-bootstrap.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: join(out, "bootstrap.cjs"),
});
const { selectHostArtifact, RemoteFrames, remoteFrame, remoteResponse, remoteRequest } = require(
  join(out, "client.cjs"),
);
for (const baseline of [true, false]) {
  const mode = baseline ? "baseline" : "fixed";
  execFileSync(process.execPath, [builderPath], {
    env: {
      ...process.env,
      FOOM_REMOTE_HOST_OUTPUT: join(out, mode),
      FOOM_COST_BASELINE: baseline ? "1" : "0",
    },
    stdio: "inherit",
  });
  const artifactDir = join(out, mode, `${process.platform}-${process.arch}`);
  const manifest = JSON.parse(await readFile(join(artifactDir, "manifest.json"), "utf8"));
  results.source = manifest.source;
  const home = await mkdtemp("/tmp/f1098-");
  const bin = join(home, "bin");
  await mkdir(bin, { mode: 0o700 });
  for (const tool of [
    "sh",
    "uname",
    "gzip",
    "head",
    "mkdir",
    "chmod",
    "mv",
    "mktemp",
    "cut",
    "wc",
    "tr",
    "rm",
    "ls",
    "date",
  ])
    await symlink(`/usr/bin/${tool}`, join(bin, tool));
  await writeFile(
    join(bin, "sha256sum"),
    '#!/bin/sh\ndate +HASH_START_%s%N >&2\n/usr/bin/sha256sum "$@"\nr=$?\ndate +HASH_END_%s%N >&2\nexit "$r"\n',
    { mode: 0o700 },
  );
  const shell = join(bin, "fixture-shell");
  // Login discovery runs only supplied command text; never source an rc file.
  await writeFile(
    shell,
    '#!/bin/sh\nif [ "$1" = "-ilc" ]; then shift; exec /bin/sh -c "$1"; fi\nif [ "$1" = "-l" ]; then shift; fi\nif [ "$1" = "-i" ]; then shift; fi\nexec /bin/sh "$@"\n',
    { mode: 0o700 },
  );
  await writeFile(
    join(bin, "claude"),
    '#!/bin/sh\ncase "$1" in --version) echo fixture-1;; --help) echo fixture-help;; *) echo FIXTURE_READY; while read -r line; do :; done;; esac\n',
    { mode: 0o700 },
  );
  const trace = join(home, "trace.jsonl");
  await writeFile(trace, "");
  await writeFile(
    join(bin, "ssh"),
    `#!${process.execPath}
const {spawn} = require('node:child_process');
const {appendFileSync} = require('node:fs');
const args = process.argv.slice(2), split = args.indexOf('--');
if (split < 0 || args[split + 1] !== 'fixture-costs') process.exit(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({stage:'ssh-entry',at:performance.timeOrigin+performance.now()})+'\\n');
if (args.at(-1) === 'uname -s; uname -m') { process.stdout.write('Linux\\n' + (process.arch === 'x64' ? 'x86_64' : 'aarch64') + '\\n'); process.exit(0); }
const child = spawn('/bin/sh', ['-c', 'exec ' + args.slice(split + 2).join(' ')], {env:${JSON.stringify({ HOME: home, PATH: bin, SHELL: shell, LANG: "C" })}, stdio:['pipe','pipe','pipe']});
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.stdin.on('error',()=>{});
process.on('SIGTERM',()=>child.kill('SIGTERM'));
child.on('close',code=>process.exit(code ?? 1));
`,
    { mode: 0o700 },
  );
  const env = { HOME: home, PATH: bin, SHELL: shell, LANG: "C" };
  const daemonStarted = now();
  const daemon = spawn(join(artifactDir, "foom-host"), ["--daemon"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const daemonClosed = once(daemon, "close");
  const daemonEvents = [];
  daemon.stderr.on("data", (bytes) => {
    for (const line of bytes.toString().trim().split("\n")) daemonEvents.push(JSON.parse(line));
  });
  const previousEnv = process.env;
  process.env = env;
  try {
    const socket = join(home, ".foom-host/host-v2.sock");
    const end = now() + 10000;
    while (!(await stat(socket).catch(() => undefined))?.isSocket()) {
      assert.ok(now() < end, "daemon startup deadline");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    results[`${mode}DaemonStartup`] = { ms: now() - daemonStarted, events: [...daemonEvents] };
    // Match the issue baseline: enrollment has already warmed local verification.
    globalThis.cost1098 = () => {};
    await selectHostArtifact(
      { host: "fixture-costs", artifact: join(artifactDir, "foom-host.gz") },
      manifest.version,
    );
    for (let index = 0; index < 7; index++) {
      const events = [];
      const record = (stage) => {
        events.push({ stage, at: now() });
        console.log(mode, index, stage);
      };
      globalThis.cost1098 = record;
      record("launch-start");
      const selected = await selectHostArtifact(
        { host: "fixture-costs", artifact: join(artifactDir, "foom-host.gz") },
        manifest.version,
      );
      record("selection-end");
      // Import the same bootstrap argv builder from the client bundle below.
      const { bootstrapArguments } = require(join(out, "bootstrap.cjs"));
      const child = spawn(
        "ssh",
        bootstrapArguments(
          "fixture-costs",
          selected.version,
          selected.sha256,
          selected.bytes.length,
          selected.upload.length,
          selected.platform,
          selected.arch,
        ),
        { env, stdio: ["pipe", "pipe", "pipe"] },
      );
      const childClosed = once(child, "close");
      record("ssh-spawn");
      let stderr = "";
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
      });
      child.stdin.on("error", () => {});
      const frames = new RemoteFrames();
      let header = Buffer.alloc(0),
        ready = false;
      const id = `fixture-cost-${index}`;
      const send = (value) => {
        assert.ok(remoteRequest(value), `Invalid fixture request: ${value.type}`);
        child.stdin.write(remoteFrame(value));
      };
      const finished = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("fixture launch deadline")), 30000);
        child.once("error", reject);
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("fixture SSH exited"));
        });
        let open = false,
          output = false,
          closed = false;
        const close = () => {
          if (open && output && !closed) {
            closed = true;
            record("pty-output-ready");
            send({ type: "kill", id, request: 3 });
          }
        };
        child.stdout.on("data", (bytes) => {
          try {
            if (!ready) {
              header = Buffer.concat([header, bytes]);
              for (;;) {
                const end = header.indexOf(10);
                if (end < 0) return;
                const line = header.subarray(0, end).toString();
                header = header.subarray(end + 1);
                record(line);
                if (line === "FOOM-UPLOAD") {
                  child.stdin.write(selected.upload);
                  continue;
                }
                assert.equal(line, "FOOM-READY");
                ready = true;
                send({ type: "hello", build: selected.sha256 });
                bytes = header;
                break;
              }
            }
            frames.push(bytes, (value) => {
              assert.ok(remoteResponse(value));
              if (value.type === "hello") {
                assert.equal(value.build, selected.sha256);
                record("hello-reply");
                send({
                  type: "open",
                  id,
                  request: 1,
                  cols: 80,
                  rows: 24,
                  reattach: false,
                  human: true,
                  profile: "a".repeat(32),
                  machine: { codeFolder: home, agent: "claude" },
                });
              } else if (value.type === "open-result") {
                assert.equal(value.state, "live");
                record("open-reply");
                open = true;
                send({ type: "attach", id, request: 2, view: "profile-view" });
                close();
              } else if (value.type === "data") {
                output ||= value.data.includes("FIXTURE_READY");
                close();
              } else if (value.type === "result" && value.request === 3) {
                clearTimeout(timer);
                resolve();
              } else if (value.type === "error")
                reject(new Error("fixture protocol operation failed"));
            });
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
      });
      try {
        await finished;
      } finally {
        child.kill("SIGTERM");
        await childClosed;
      }
      for (const line of stderr.trim().split("\n")) {
        if (line.startsWith("{")) {
          const row = JSON.parse(line);
          events.push({ stage: row.cost1098, at: row.at });
        } else if (/^HASH_(START|END)_\d+$/.test(line)) {
          const [, stage, at] = /^HASH_(START|END)_(\d+)$/.exec(line);
          events.push({ stage: `remote-hash-${stage.toLowerCase()}`, at: Number(at) / 1e6 });
        } else if (line) throw new Error("Unexpected fixture stderr");
      }
      results.runs.push({
        mode,
        index,
        bytes: manifest.size,
        gzipBytes: manifest.gzipSize,
        events,
        sshEvents: (await readFile(trace, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((event) => event.at >= events[0].at),
      });
      await writeFile(join(out, "measurements.partial.json"), JSON.stringify(results, null, 2));
    }
  } finally {
    process.env = previousEnv;
    daemon.kill("SIGTERM");
    await daemonClosed;
    results.runs
      .filter((row) => row.mode === mode)
      .forEach((row) => {
        row.daemonEvents = daemonEvents.filter(
          (event) =>
            event.at >= row.events[0].at &&
            event.at <= Math.max(...row.events.map((event) => event.at)),
        );
      });
    await rm(home, { recursive: true, force: true });
  }
}
await writeFile(join(out, "measurements.json"), JSON.stringify(results, null, 2));
console.log(`Measurements: ${join(out, "measurements.json")}`);
