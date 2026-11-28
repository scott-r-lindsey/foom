import ts from "typescript";
import { gitSync } from "../tests/helpers/git.js";
import { evidencePath } from "../tests/helpers/evidence.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostPlatforms } from "./remote-host-artifacts.mjs";

function fixture(context, { timeout } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "foom-wrapper-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "tests/helpers", "tests/electron", "src", "node_modules"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  for (const name of [
    "electron-tests.mjs",
    "electron-selection.mjs",
    "electron-registration.mjs",
    "electron-registration-worker.cjs",
    "electron-summary.mjs",
    "validation-fingerprint.mjs",
    "build-inputs.mjs",
    "bundle-build.mjs",
    "node-runtime.mjs",
    "remote-host-artifacts.mjs",
  ]) {
    cpSync(new URL(name, import.meta.url), join(root, "scripts", name));
  }
  for (const name of [
    "test-shard.js",
    "test-suites.js",
    "shard-assignment.js",
    "shard-plan.json",
  ]) {
    cpSync(
      new URL(`../tests/electron/${name}`, import.meta.url),
      join(root, "tests/electron", name),
    );
  }
  for (const name of ["package.json", "pnpm-lock.yaml", ".npmrc", "tests/helpers/setup.js"]) {
    writeFileSync(join(root, name), name === "package.json" ? '{"version":"0.1.0"}' : "");
  }
  for (const name of ["git.js", "worktree-writes.js"]) {
    cpSync(new URL(`../tests/helpers/${name}`, import.meta.url), join(root, "tests/helpers", name));
  }
  writeFileSync(join(root, ".gitignore"), "build/\ntest-results/\nnode_modules/\n");
  writeFileSync(join(root, "src/input.ts"), "original");
  writeFileSync(join(root, "node_modules/types.d.ts"), "original declaration");
  writeFileSync(join(root, "node_modules/.modules.yaml"), "fixture install state");
  mkdirSync(join(root, "node_modules/typescript"));
  writeFileSync(
    join(root, "node_modules/typescript/index.js"),
    `module.exports = require(${JSON.stringify(fileURLToPath(import.meta.resolve("typescript")))});`,
  );
  mkdirSync(join(root, "node_modules/electron"));
  writeFileSync(
    join(root, "node_modules/electron/index.js"),
    `
    const { existsSync, writeFileSync } = require('node:fs');
    if (!existsSync('node_modules/electron/path.txt'))
      writeFileSync('node_modules/electron/path.txt', 'installed lazily');
  `,
  );
  writeFileSync(
    join(root, "scripts/build.mjs"),
    `
    import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
    appendFileSync('test-results/app-builds', 'build\\n');
    readFileSync('src/input.ts');
    readFileSync('node_modules/types.d.ts');
    if (process.env.ESBUILD_BINARY_PATH === 'broken-esbuild') throw Error('esbuild fixture failed');
    rmSync('build', { recursive: true, force: true });
    mkdirSync('build', { recursive: true });
    writeFileSync('build/app.js', 'built');
  `,
  );
  writeFileSync(
    join(root, "scripts/build-remote-host.mjs"),
    `
    import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
    import { checkoutRevision, writeHostManifest } from './remote-host-artifacts.mjs';
    if (!existsSync('build/app.js')) throw Error('host built before app');
    appendFileSync('test-results/host-builds', 'build\\n');
    mkdirSync('build/remote-host', { recursive: true });
    writeFileSync('build/remote-host/foom-host', 'fixture host');
    if (process.platform === 'darwin') {
      mkdirSync('build/remote-sea');
      writeFileSync('build/remote-sea/pty.node', 'fixture pty');
      writeFileSync('build/remote-sea/spawn-helper', 'fixture helper');
    }
    if (process.env.TEST_HOST_FAILURE === 'build') process.exit(7);
    const manifest = await writeHostManifest('build/remote-host', {
      version: '0.1.0', platform: process.platform, arch: process.arch,
      source: checkoutRevision(process.cwd()),
    });
    if (process.env.TEST_HOST_FAILURE === 'revision') {
      manifest.source = 'a'.repeat(40);
      writeFileSync('build/remote-host/manifest.json', JSON.stringify(manifest));
    }
    if (process.env.TEST_HOST_FAILURE === 'gzip')
      writeFileSync('build/remote-host/foom-host.gz', 'corrupt');
    if (process.env.TEST_HOST_FAILURE === 'executable')
      writeFileSync('build/remote-host/foom-host', 'corrupt');
  `,
  );
  const suite = `const { test } = require('./test-shard.js');
    test('selected case', () => {
      require('node:assert/strict').ok(process.execArgv.includes('--test-concurrency=1'));
      console.log('SELECTED_BODY');
    });
    test('other case', () => { throw Error('UNSELECTED_BODY'); });`;
  for (const name of ["one.test.js", "packaged-smoke.js"]) {
    writeFileSync(join(root, "tests/electron", name), suite);
  }
  gitSync(["init", "--quiet"], { cwd: root });
  gitSync(["add", "."], { cwd: root });
  gitSync(
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "fixture"],
    { cwd: root },
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.FOOM_ELECTRON_SHARD;
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  delete env.FOOM_CI_ELECTRON_SUITES;
  delete env.FOOM_PACKAGE;
  delete env.FOOM_REQUIRE_REMOTE_HOSTS;
  delete env.FOOM_REMOTE_HOST_ARTIFACTS;
  delete env.ESBUILD_BINARY_PATH;
  delete env.NODE_OPTIONS;
  return {
    root,
    run: (args, extraEnv = {}, executable = process.execPath) => {
      const result = spawnSync(executable, ["scripts/electron-tests.mjs", ...args], {
        cwd: root,
        env: { ...env, ...extraEnv },
        encoding: "utf8",
        timeout,
      });
      return { ...result, output: result.stdout + result.stderr };
    },
  };
}

test("wrapper forwards both filter forms, reports executed tests and preserves sharding", (context) => {
  const { root, run } = fixture(context);
  for (const args of [
    ["--test-name-pattern", "^selected case$"],
    ["--test-name-pattern=^selected case$"],
  ]) {
    const result = run(args, { FOOM_ELECTRON_SHARD: "1/1" });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /SELECTED_BODY/);
    assert.doesNotMatch(result.output, /UNSELECTED_BODY/);
    assert.match(result.output, /1 selected tests passed/);
    assert.ok(
      readFileSync(join(root, "test-results/electron.xml"), "utf8").includes("selected case"),
    );
  }
  const shards = ["1/2", "2/2"].map((shard) =>
    run(["--reuse-build", "--test-name-pattern=^selected case$"], { FOOM_ELECTRON_SHARD: shard }),
  );
  assert.equal(shards.filter((result) => result.status === 0).length, 1);
  assert.match(shards.find((result) => result.status !== 0).output, /No selected tests passed/);
  writeFileSync(
    join(root, "tests/electron/two.test.js"),
    `const { test } = require('./test-shard.js');
      test('selected second', () => {
        require('node:assert/strict').ok(process.execArgv.includes('--test-concurrency=1'));
      });`,
  );
  const single = run(["--reuse-build", "--test-name-pattern=/^SELECTED CASE$/i"]);
  assert.equal(single.status, 0, single.output);
  assert.match(single.output, /1 of 2 suite files/);
  assert.doesNotMatch(single.output, /two\.test\.js/);
  const multiple = run([
    "--reuse-build",
    "--test-name-pattern=^selected case$",
    "--test-name-pattern=^selected second$",
  ]);
  assert.equal(multiple.status, 0, multiple.output);
  assert.match(multiple.output, /2 selected tests passed/);

  const missing = run(["--reuse-build", "--test-name-pattern=^missing$"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.output, /No selected tests passed/);
  assert.match(missing.output, /one\.test\.js/);
  assert.match(missing.output, /two\.test\.js/);

  writeFileSync(
    join(root, "tests/electron/two.test.js"),
    `const { test } = require('./test-shard.js');
      if (process.env.NODE_TEST_CONTEXT) test('selected case', () => {});`,
  );
  const uncertain = run(["--reuse-build", "--test-name-pattern=^selected case$"]);
  assert.equal(uncertain.status, 0, uncertain.output);
  assert.match(uncertain.output, /2 selected tests passed/);

  const packaged = run(["--packaged", "--test-name-pattern=^selected case$"]);
  assert.equal(packaged.status, 0, packaged.output);
});

test("the wrapper loads every inventory file once in CI and in shard runs", (context) => {
  const { root, run } = fixture(context);
  const directory = join(root, "tests/electron");
  writeFileSync(
    join(directory, "shard-plan.json"),
    JSON.stringify({ shards: { 2: [{ "first case": [] }, { "second case": [] }] } }),
  );
  for (const [file, name] of [
    ["one", "first"],
    ["two", "second"],
  ]) {
    writeFileSync(
      join(directory, `${file}.test.js`),
      `const { test } = require('./test-shard.js');
        require('node:fs').appendFileSync('test-results/suites-loaded', ${JSON.stringify(name + "\n")});
        test('${name} case', () => {});`,
    );
  }
  const filter = "--test-name-pattern=^second case$";
  const inventory = "first\nsecond\n";
  for (const [args, env, expectedLoads] of [
    [[], { FOOM_ELECTRON_SHARD: "2/2" }, inventory],
    [[filter], { FOOM_ELECTRON_SHARD: "2/2" }, inventory],
    [[filter], { CI: "true", FOOM_ELECTRON_SHARD: "2/2" }, inventory],
    [[filter], { CI: "true" }, inventory],
    [[filter], { CI: "" }, inventory],
    [[filter, "--suite=two.test.js"], { CI: "true", FOOM_ELECTRON_SHARD: "2/2" }, "second\n"],
  ]) {
    const result = run(args, env);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /second case/);
    assert.doesNotMatch(result.output, /first case|Electron test selection:/);
    const loaded = join(root, "test-results/suites-loaded");
    assert.equal(readFileSync(loaded, "utf8"), expectedLoads);
    rmSync(loaded);
  }
});

test("wrapper rejects invalid options, invalid regexes, zero matches, and propagates failures", (context) => {
  const { run } = fixture(context);
  for (const args of [
    ["--typo"],
    ["--test-name-pattern"],
    ["--test-name-pattern="],
    ["--test-name-pattern=["],
    ["--packaged", "--reuse-build"],
    ["--packaged", "--fresh"],
    ["--reuse-build", "--fresh"],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0, result.output);
  }
  const missing = run(["--test-name-pattern=does not exist"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.output, /No selected tests passed/);
  const failed = run(["--reuse-build", "--test-name-pattern=other case"]);
  assert.notEqual(failed.status, 0);
  assert.match(failed.output, /UNSELECTED_BODY/);
});

test("explicit build reuse rejects missing receipts and changed inputs, dependencies or output", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  assert.notEqual(run(["--reuse-build", filter]).status, 0);
  assert.equal(run([filter]).status, 0);
  assert.equal(run(["--reuse-build", filter]).status, 0);
  for (const file of [
    "src/input.ts",
    "node_modules/types.d.ts",
    "node_modules/.modules.yaml",
    "pnpm-lock.yaml",
    "scripts/build.mjs",
    "build/app.js",
  ]) {
    const path = join(root, file);
    const before = readFileSync(path, "utf8");
    writeFileSync(path, before + "\n// change");
    assert.notEqual(run(["--reuse-build", filter]).status, 0, file);
    writeFileSync(path, before);
    assert.equal(run(["--reuse-build", filter]).status, 0, file);
  }
});

test("local runs reuse a matching build and rebuild when its receipt, inputs or output change", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  const builds = () =>
    readFileSync(join(root, "test-results/app-builds"), "utf8").trim().split("\n").length;
  const invalidations = [
    () => writeFileSync(join(root, "src/input.ts"), "changed"),
    () => writeFileSync(join(root, "node_modules/types.d.ts"), "changed"),
    () => writeFileSync(join(root, "build/app.js"), "corrupt"),
    () => rmSync(join(root, "build"), { recursive: true }),
    () => writeFileSync(join(root, "test-results/electron-build.json"), "null"),
    () => writeFileSync(join(root, "test-results/electron-build.json"), "{"),
    () => rmSync(join(root, "test-results/electron-build.json")),
  ];
  for (let index = 0; index <= invalidations.length; index++) {
    if (index > 0) invalidations[index - 1]();
    const built = run([filter]);
    assert.equal(built.status, 0, built.output);
    assert.doesNotMatch(built.output, /Reusing verified/);
    assert.equal(builds(), index + 1);
    assert.equal(
      readFileSync(join(root, "node_modules/electron/path.txt"), "utf8"),
      "installed lazily",
    );
    assert.equal(readFileSync(join(root, "build/app.js"), "utf8"), "built");
    if (index === 0 || index === invalidations.length) {
      const reused = run([filter]);
      assert.equal(reused.status, 0, reused.output);
      assert.match(reused.output, /Reusing verified current Electron build/);
      assert.equal(builds(), index + 1);
    }
  }
});

function installFixtureCompiler(root, { compile = true } = {}) {
  const compiler = fileURLToPath(import.meta.resolve("typescript"));
  mkdirSync(join(root, "node_modules/typescript"), { recursive: true });
  cpSync(dirname(compiler), join(root, "node_modules/typescript/lib"), { recursive: true });
  cpSync(
    join(dirname(compiler), "../package.json"),
    join(root, "node_modules/typescript/package.json"),
  );
  if (!compile) return;
  appendFileSync(
    join(root, "scripts/build.mjs"),
    `
    import { execFileSync } from 'node:child_process';
    execFileSync(process.execPath, ['node_modules/typescript/lib/tsc.js', '-p', 'tsconfig.main.json'], { stdio: 'inherit' });
  `,
  );
}

test("local reuse fingerprints transitive relative and package tsconfig bases", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  const shared = join(root, "compiler-config");
  const preset = join(shared, "node_modules/@fixture/tsconfig");
  mkdirSync(preset, { recursive: true });
  installFixtureCompiler(root);
  writeFileSync(join(root, "src/input.ts"), "export {};");
  writeFileSync(
    join(root, "tsconfig.main.json"),
    JSON.stringify({
      extends: "./tsconfig.base.json",
      compilerOptions: { noEmit: true },
      files: ["src/input.ts"],
    }),
  );
  writeFileSync(join(root, "tsconfig.base.json"), '{"extends":"./compiler-config/base"}');
  writeFileSync(join(shared, "base.json"), '{"extends":["@fixture/tsconfig","./relative"]}');
  writeFileSync(join(preset, "package.json"), '{"tsconfig":"preset.json"}');
  const changed = [join(preset, "preset.json"), join(shared, "relative.json")];
  for (const file of changed) writeFileSync(file, '{"compilerOptions":{"strict":true}}');
  const check = (reused) => {
    const result = run([filter]);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.output.includes("Reusing verified"), reused, result.output);
  };
  check(false);
  check(true);
  for (const file of changed) {
    writeFileSync(file, '{"compilerOptions":{"strict":false}}');
    check(false);
    check(true);
  }
  rmSync(changed[1]);
  assert.notEqual(run(["--reuse-build", filter]).status, 0);
  const failed = run([filter]);
  assert.notEqual(failed.status, 0);
  assert.match(failed.output, /TS6053/);
});

test("local reuse rebuilds when a declaration outside src consumed by tsc changes", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  installFixtureCompiler(root);
  mkdirSync(join(root, "declarations"));
  writeFileSync(
    join(root, "tsconfig.main.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [] },
      include: ["src", "declarations/ambient.d.ts"],
    }),
  );
  writeFileSync(join(root, "src/input.ts"), 'const value: BuildValue = "original";');
  const ambient = join(root, "declarations/ambient.d.ts");
  writeFileSync(ambient, "type BuildValue = string;");
  assert.equal(run([filter]).status, 0);
  assert.match(run([filter]).output, /Reusing verified/);
  writeFileSync(ambient, "type BuildValue = number;");
  const rebuilt = run([filter]);
  assert.notEqual(rebuilt.status, 0, rebuilt.output);
  assert.match(rebuilt.output, /TS2322/);
  assert.doesNotMatch(rebuilt.output, /SELECTED_BODY/);
});

function useFixtureEsbuild(root) {
  const modules = join(dirname(fileURLToPath(import.meta.resolve("esbuild"))), "../..");
  for (const name of ["esbuild", "@esbuild"])
    cpSync(join(modules, name), join(root, "node_modules", name), { recursive: true });
}

test("an optional relative esbuild import invalidates reuse when its source appears", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  useFixtureEsbuild(root);
  mkdirSync(join(root, "src/plugins/folder"), { recursive: true });
  writeFileSync(
    join(root, "src/input.ts"),
    `
    for (const marker of [
      (() => { try { return require('./plugins/optional.js'); } catch { return 'fallback'; } })(),
      (() => { try { return require('./plugins/folder'); } catch { return 'folder fallback'; } })(),
    ]) console.log(marker);
    `,
  );
  appendFileSync(
    join(root, "scripts/build.mjs"),
    `
    import { bundleBuild } from './bundle-build.mjs';
    await bundleBuild({
      entryPoints: ['src/input.ts'],
      bundle: true,
      platform: 'node',
      outfile: 'build/optional.cjs',
    });
    `,
  );
  const check = (expected, reuse) => {
    const result = run([filter]);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.output.includes("Reusing verified"), reuse, result.output);
    assert.equal(
      execFileSync(process.execPath, [join(root, "build/optional.cjs")], {
        encoding: "utf8",
      }).trim(),
      expected,
    );
  };
  check("fallback\nfolder fallback", false);
  check("fallback\nfolder fallback", true);
  writeFileSync(join(root, "src/plugins/optional.js"), "module.exports = 'optional file';");
  check("optional file\nfolder fallback", false);
  writeFileSync(join(root, "src/plugins/folder/index.js"), "module.exports = 'optional folder';");
  check("optional file\noptional folder", false);
  check("optional file\noptional folder", true);
});

test("macOS ad-hoc signing permits reuse with the system codesign", {
  skip: process.platform !== "darwin",
}, (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  cpSync("/usr/bin/true", join(root, "src/signing-fixture"));
  appendFileSync(
    join(root, "scripts/build.mjs"),
    `
    import { execFileSync, spawnSync } from 'node:child_process';
    import { copyFileSync } from 'node:fs';
    copyFileSync('src/signing-fixture', 'build/signing-fixture');
    execFileSync('codesign', ['--force', '--sign', '-', 'build/signing-fixture']);
    const verify = spawnSync('codesign', ['--verify', '--strict', 'build/signing-fixture']);
    if (verify.status !== 0) throw Error(String(verify.stderr));
    `,
  );
  const bin = join(root, "src/bin");
  mkdirSync(bin);
  const env = { PATH: [bin, "/usr/bin", "/bin"].join(delimiter) };
  const built = run([filter], env);
  assert.equal(built.status, 0, built.output);
  assert.doesNotMatch(built.output, /Reusing verified/);
  const reused = run(["--reuse-build", filter], env);
  assert.equal(reused.status, 0, reused.output);
  assert.match(reused.output, /Reusing verified/);
  cpSync("/usr/bin/codesign", join(bin, "codesign"));
  const shadowed = run(["--reuse-build", filter], env);
  assert.notEqual(shadowed.status, 0);
  assert.match(shadowed.output, /No current verified build/);
});

test("esbuild tracks an external stylesheet imported by the renderer", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  mkdirSync(join(root, "src/renderer/styles"), { recursive: true });
  mkdirSync(join(root, "theme"));
  const theme = join(root, "theme/theme.css");
  const unused = join(root, "theme/unused.css");
  writeFileSync(unused, "/* unreferenced */");
  writeFileSync(theme, "body { color: red; }");
  writeFileSync(
    join(root, "src/renderer/styles/styles.css"),
    '@import "../../../theme/theme.css";',
  );
  useFixtureEsbuild(root);
  appendFileSync(
    join(root, "scripts/build.mjs"),
    `
    import { bundleBuild } from './bundle-build.mjs';
    await bundleBuild({
      entryPoints: ['src/renderer/styles/styles.css'],
      bundle: true,
      outfile: 'build/styles.css',
    });
  `,
  );
  const built = run([filter]);
  assert.equal(built.status, 0, built.output);
  const first = JSON.parse(readFileSync(join(root, "test-results/electron-build.json"), "utf8"));
  assert.ok(
    first.snapshot.inputs.some(([file, hash]) => file === theme && /^[a-f0-9]{64}$/.test(hash)),
  );
  writeFileSync(unused, "/* edited without changing the graph */");
  assert.match(run([filter]).output, /Reusing verified/);
  writeFileSync(theme, "body { color: blue; }");
  assert.match(run(["--reuse-build", filter]).output, /No current verified build/);
  const rebuilt = run([filter]);
  assert.equal(rebuilt.status, 0, rebuilt.output);
  assert.doesNotMatch(rebuilt.output, /Reusing verified/);
  assert.match(readFileSync(join(root, "build/styles.css"), "utf8"), /color: blue/);
});

test("cold and damaged icon caches build successfully and can be reused", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  cpSync(new URL("./icon/", import.meta.url), join(root, "scripts/icon"), { recursive: true });
  appendFileSync(
    join(root, "scripts/build.mjs"),
    `
    import { writeIcons, ICON_FILES } from './icon/foom-icon.mjs';
    const rendered = await writeIcons('build/icons', {
      generate: () => new Map(ICON_FILES.map(name => [name, Buffer.from(name)])),
    });
    console.log('RENDERED_ICONS', rendered);
  `,
  );
  appendFileSync(join(root, ".gitignore"), ".cache/\n");
  const cacheRoot = join(root, ".cache/foom-icons");
  const first = run([filter]);
  assert.equal(first.status, 0, first.output);
  assert.match(first.output, /RENDERED_ICONS true/);
  assert.match(run([filter]).output, /Reusing verified/);
  const manifest = join(cacheRoot, readdirSync(cacheRoot)[0], "manifest.json");
  rmSync(join(root, "build/icons"), { recursive: true });
  const cached = run([filter]);
  assert.equal(cached.status, 0, cached.output);
  assert.match(cached.output, /RENDERED_ICONS false/);
  assert.match(run([filter]).output, /Reusing verified/);
  writeFileSync(manifest, "{");
  const repaired = run([filter]);
  assert.equal(repaired.status, 0, repaired.output);
  assert.match(repaired.output, /RENDERED_ICONS true/);
  assert.match(run([filter]).output, /Reusing verified/);
});

test("esbuild builds fresh each time it uses a source outside the checkout", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  const external = realpathSync(mkdtempSync(join(tmpdir(), "foom-esbuild-config-")));
  context.after(() => rmSync(external, { recursive: true, force: true }));
  mkdirSync(join(external, "nested"));
  const source = join(external, "nested", "fields.ts");
  const config = join(external, "tsconfig.json");
  const setFields = (enabled) =>
    writeFileSync(
      config,
      JSON.stringify({ compilerOptions: { useDefineForClassFields: enabled } }),
    );
  writeFileSync(source, "export class Example { value = 1; }");
  setFields(false);
  useFixtureEsbuild(root);
  installFixtureCompiler(root, { compile: false });
  writeFileSync(
    join(root, "src/input.ts"),
    `export { Example } from ${JSON.stringify(source.split("\\").join("/"))};`,
  );
  appendFileSync(
    join(root, "scripts/build.mjs"),
    `
    import { bundleBuild } from './bundle-build.mjs';
    await bundleBuild({
      entryPoints: ['src/input.ts'],
      bundle: true,
      format: 'esm',
      target: 'esnext',
      outfile: 'build/fields.js',
    });
  `,
  );
  const built = run([filter]);
  assert.equal(built.status, 0, built.output);
  assert.match(readFileSync(join(root, "build/fields.js"), "utf8"), /this\.value = 1/);
  assert.match(run(["--reuse-build", filter]).output, /No current verified build/);
  const repeated = run([filter]);
  assert.equal(repeated.status, 0, repeated.output);
  assert.doesNotMatch(repeated.output, /Reusing verified/);
  setFields(true);
  const rebuilt = run([filter]);
  assert.equal(rebuilt.status, 0, rebuilt.output);
  assert.doesNotMatch(rebuilt.output, /Reusing verified/);
  assert.match(readFileSync(join(root, "build/fields.js"), "utf8"), /^\s+value = 1;/m);
});

test("a nearer installed package providing an esbuild deep subpath forces a fresh build", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  useFixtureEsbuild(root);
  writeFileSync(
    join(root, "src/input.ts"),
    'import { marker } from "fixture-dep/lib/deep"; console.log(marker);',
  );
  appendFileSync(
    join(root, "scripts/build.mjs"),
    `
    import { bundleBuild } from './bundle-build.mjs';
    await bundleBuild({ entryPoints: ['src/input.ts'], bundle: true, outfile: 'build/deep.js' });
  `,
  );
  const addDependency = (modules, marker) => {
    const lib = join(modules, "fixture-dep/lib");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "deep.js"), `export const marker = "${marker}";`);
  };
  const check = (marker, reuse) => {
    const result = run([filter]);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.output.includes("Reusing verified"), reuse, result.output);
    assert.ok(readFileSync(join(root, "build/deep.js"), "utf8").includes(marker));
  };
  const nearer = join(root, "src/node_modules");
  addDependency(join(root, "node_modules"), "original deep subpath");
  mkdirSync(nearer);
  check("original deep subpath", false);
  check("original deep subpath", true);
  addDependency(nearer, "nearer deep subpath");
  check("nearer deep subpath", false);
  check("nearer deep subpath", true);
  rmSync(nearer, { recursive: true });
  check("original deep subpath", false);
});

test("a Node build tool using a package outside the checkout always builds fresh", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "foom-wrapper-package-")));
  context.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(join(outside, "lib"));
  for (const marker of ["first", "second"])
    writeFileSync(join(outside, "lib", `${marker}.cjs`), `module.exports = "${marker}";`);
  appendFileSync(
    join(root, "scripts/build.mjs"),
    `
    import { createRequire } from 'node:module';
    writeFileSync('build/tool-result', createRequire(import.meta.url)(${JSON.stringify(outside)}));
  `,
  );
  const check = (marker) => {
    const result = run([filter]);
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /Reusing verified/);
    assert.equal(readFileSync(join(root, "build/tool-result"), "utf8"), marker);
  };
  writeFileSync(join(outside, "package.json"), '{"main":"lib/first.cjs"}');
  check("first");
  assert.match(run(["--reuse-build", filter]).output, /No current verified build/);
  check("first");
  writeFileSync(join(outside, "package.json"), '{"main":"lib/second.cjs"}');
  check("second");
});

test("a nested node_modules copy that shadows a build tool dependency forces a fresh build", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  const tool = join(root, "node_modules/fixture-tool");
  mkdirSync(join(tool, "lib"), { recursive: true });
  writeFileSync(join(tool, "lib/build.cjs"), 'module.exports = require("fixture-dep");');
  appendFileSync(
    join(root, "scripts/build.mjs"),
    `
    import result from 'fixture-tool/lib/build.cjs';
    writeFileSync('build/tool-result', result);
  `,
  );
  const addDependency = (modules, marker) => {
    const dependency = join(modules, "fixture-dep");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, "index.js"), `module.exports = "${marker}";`);
  };
  const check = (marker, reuse) => {
    const result = run([filter]);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.output.includes("Reusing verified"), reuse, result.output);
    assert.equal(readFileSync(join(root, "build/tool-result"), "utf8"), marker);
  };
  const nested = join(tool, "node_modules");
  addDependency(join(root, "node_modules"), "hoisted");
  check("hoisted", false);
  check("hoisted", true);
  mkdirSync(nested);
  check("hoisted", false);
  check("hoisted", true);
  addDependency(nested, "shadow");
  check("shadow", false);
  check("shadow", true);
  rmSync(nested, { recursive: true });
  check("hoisted", false);
});

test("hand edits to unrecorded installed files can be missed until --fresh", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  const dependency = join(root, "node_modules/types.d.ts");
  const unrecorded = join(root, "node_modules/optional.d.ts");
  const help = run(["--help"]);
  assert.equal(help.status, 0, help.output);
  assert.match(help.output, /Hand edits inside node_modules can go\s+undetected/);
  assert.match(help.output, /Use --fresh/);
  writeFileSync(unrecorded, "original");
  assert.equal(run([filter]).status, 0);
  writeFileSync(unrecorded, "edited by hand");
  const reused = run([filter]);
  assert.equal(reused.status, 0, reused.output);
  assert.match(reused.output, /Reusing verified/);
  const rebuilt = run(["--fresh", filter]);
  assert.equal(rebuilt.status, 0, rebuilt.output);
  assert.doesNotMatch(rebuilt.output, /Reusing verified/);
  assert.equal(readFileSync(join(root, "test-results/app-builds"), "utf8"), "build\nbuild\n");
  writeFileSync(dependency, "edited recorded declaration");
  assert.match(run(["--reuse-build", filter]).output, /No current verified build/);
});

test("reuse requires pnpm install state and checks either state file when present", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  rmSync(join(root, "node_modules/.modules.yaml"));
  for (let index = 0; index < 2; index++) {
    const result = run([filter]);
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /Reusing verified/);
  }
  const lock = join(root, "node_modules/.pnpm/lock.yaml");
  mkdirSync(dirname(lock));
  writeFileSync(lock, "first install");
  assert.equal(run([filter]).status, 0);
  assert.match(run([filter]).output, /Reusing verified/);
  writeFileSync(lock, "second install");
  assert.match(run(["--reuse-build", filter]).output, /No current verified build/);
  assert.equal(run([filter]).status, 0);
  writeFileSync(join(root, "node_modules/.modules.yaml"), "added install state");
  assert.match(run(["--reuse-build", filter]).output, /No current verified build/);
});

test("a newly executable earlier PATH entry invalidates the selected tool", {
  skip: process.platform === "win32",
}, (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  const early = join(root, "test-results/early");
  const late = join(root, "test-results/late");
  mkdirSync(early, { recursive: true });
  mkdirSync(late, { recursive: true });
  const env = { PATH: [early, late, process.env.PATH].join(delimiter) };
  const putTool = (dir, result, mode) =>
    writeFileSync(join(dir, "foom-fixture-tool"), `#!/bin/sh\nprintf '${result}'\n`, { mode });
  putTool(late, "later", 0o700);
  appendFileSync(
    join(root, "scripts/build.mjs"),
    `
    import { execFileSync } from 'node:child_process';
    writeFileSync('build/tool-result', execFileSync('foom-fixture-tool'));
  `,
  );
  const output = () => readFileSync(join(root, "build/tool-result"), "utf8");
  const check = (reused) => {
    const result = run([filter], env);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.output.includes("Reusing verified"), reused, result.output);
  };
  check(false);
  assert.equal(output(), "later");
  check(true);
  putTool(early, "new", 0o700);
  check(false);
  assert.equal(output(), "new");
  rmSync(join(early, "foom-fixture-tool"));
  check(false);
  assert.equal(output(), "later");
  putTool(early, "earlier", 0o600);
  check(true);
  chmodSync(join(early, "foom-fixture-tool"), 0o700);
  check(false);
  assert.equal(output(), "earlier");
  check(true);
});

test("a FIFO receipt is rejected and automatic reuse rebuilds without opening it", {
  skip: process.platform === "win32",
}, (context) => {
  const { root, run } = fixture(context, { timeout: 5000 });
  const filter = "--test-name-pattern=^selected case$";
  mkdirSync(join(root, "test-results"));
  execFileSync("mkfifo", [join(root, "test-results/electron-build.json")]);
  const strict = run(["--reuse-build", filter]);
  assert.equal(strict.status, 1, strict.error?.message ?? strict.output);
  assert.match(strict.output, /No current verified build/);
  const fresh = run([filter]);
  assert.equal(fresh.status, 0, fresh.error?.message ?? fresh.output);
  assert.doesNotMatch(fresh.output, /Reusing verified/);
  assert.match(run([filter]).output, /Reusing verified/);
});

test("fresh runner executes tests when a copied asset symlink prevents reuse", {
  skip: process.platform === "win32",
}, (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  symlinkSync("input.ts", join(root, "src/alias.ts"));
  appendFileSync(
    join(root, "scripts/build.mjs"),
    `
    import { cpSync } from 'node:fs';
    cpSync('src/alias.ts', 'build/alias.ts');
  `,
  );
  for (let index = 0; index < 2; index++) {
    const fresh = run([filter]);
    assert.equal(fresh.status, 0, fresh.output);
    assert.match(fresh.output, /SELECTED_BODY/);
    assert.doesNotMatch(fresh.output, /Reusing verified/);
  }
  assert.throws(() => readFileSync(join(root, "test-results/electron-build.json")), {
    code: "ENOENT",
  });
  assert.match(run(["--reuse-build", filter]).output, /No current verified build/);
});

test("Darwin fixture spawn-helper must retain its owner execute bit", {
  skip: process.platform === "win32",
}, (context) => {
  const { root } = fixture(context);
  const native = join(root, "build/remote-host/native");
  const source = join(root, "build/remote-sea");
  mkdirSync(native, { recursive: true, mode: 0o700 });
  mkdirSync(source, { recursive: true });
  const helper = join(native, "spawn-helper");
  writeFileSync(join(source, "spawn-helper"), "fixture helper");
  writeFileSync(helper, "fixture helper", { mode: 0o700 });
  const verify = () =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { buildOutputFingerprint } from './scripts/validation-fingerprint.mjs';
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    console.log(buildOutputFingerprint());
  `,
      ],
      { cwd: root, encoding: "utf8" },
    );
  const valid = verify();
  assert.equal(valid.status, 0, valid.stderr);
  chmodSync(helper, 0o600);
  const invalid = verify();
  assert.notEqual(invalid.status, 0, invalid.stdout);
  assert.match(invalid.stderr, /Unsafe fixture asset/);
});

for (const kind of ["symlink", "FIFO"]) {
  test(`local reuse rebuilds for a ${kind} in build output`, {
    skip: process.platform === "win32",
  }, (context) => {
    const { root, run } = fixture(context, { timeout: kind === "FIFO" ? 5000 : undefined });
    const filter = "--test-name-pattern=^selected case$";
    assert.equal(run([filter]).status, 0);
    const output = join(root, "build/app.js");
    rmSync(output);
    if (kind === "symlink") {
      const identical = join(root, "test-results/identical.js");
      writeFileSync(identical, "built");
      symlinkSync(identical, output);
    } else {
      execFileSync("mkfifo", [output]);
    }
    const strict = run(["--reuse-build", filter]);
    assert.equal(strict.status, 1, strict.error?.message ?? strict.output);
    assert.match(strict.output, /No current verified build/);
    const rebuilt = run([filter]);
    assert.equal(rebuilt.status, 0, rebuilt.output);
    assert.doesNotMatch(rebuilt.output, /Reusing verified/);
    assert.equal(readFileSync(join(root, "test-results/app-builds"), "utf8"), "build\nbuild\n");
  });
}

test("CI and custom catalog runs rebuild even when a local receipt matches", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  for (const env of [
    { CI: "true" },
    { GITHUB_ACTIONS: "true" },
    { FOOM_CI_ELECTRON_SUITES: "[]" },
    { FOOM_REQUIRE_REMOTE_HOSTS: "1" },
  ]) {
    for (const invocation of [{}, env, env, {}]) {
      const result = run([filter], invocation);
      assert.equal(result.status, 0, result.output);
      assert.doesNotMatch(result.output, /Reusing verified/);
    }
    assert.match(run([filter]).output, /Reusing verified current Electron build/);
    // Start each iteration with a fresh local build.
    rmSync(join(root, "test-results/electron-build.json"));
  }
  assert.equal(run([filter]).status, 0);
  for (const env of [
    { FOOM_REQUIRE_REMOTE_HOSTS: "1" },
    { FOOM_REMOTE_HOST_ARTIFACTS: "custom-hosts" },
  ]) {
    const strict = run(["--reuse-build", filter], env);
    assert.notEqual(strict.status, 0, strict.output);
    assert.doesNotMatch(strict.output, /SELECTED_BODY/);
  }
});

test("esbuild overrides require a fresh build and never leave a reusable receipt", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  assert.equal(run([filter]).status, 0);
  const override = { ESBUILD_BINARY_PATH: "broken-esbuild" };
  const strict = run(["--reuse-build", filter], override);
  assert.notEqual(strict.status, 0, strict.output);
  assert.match(strict.output, /ESBUILD_BINARY_PATH requires a fresh build/);
  assert.doesNotMatch(strict.output, /SELECTED_BODY/);

  const failed = run([filter], override);
  assert.notEqual(failed.status, 0, failed.output);
  assert.match(failed.output, /esbuild fixture failed/);
  assert.doesNotMatch(failed.output, /SELECTED_BODY/);

  assert.equal(run([filter]).status, 0);
  const built = run([filter], { ESBUILD_BINARY_PATH: "working-esbuild" });
  assert.equal(built.status, 0, built.output);
  assert.doesNotMatch(built.output, /Reusing verified/);
  assert.throws(() => readFileSync(join(root, "test-results/electron-build.json")), {
    code: "ENOENT",
  });
  const normal = run([filter]);
  assert.equal(normal.status, 0, normal.output);
  assert.doesNotMatch(normal.output, /Reusing verified/);
});

test("Node startup hooks rebuild even when the hook lives outside the input snapshot", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  assert.equal(run([filter]).status, 0);
  const hook = join(root, "test-results/build-hook.mjs");
  const output = join(root, "build/app.js");
  const env = { NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` };
  for (const marker of ["first instrumentation", "updated instrumentation"]) {
    writeFileSync(
      hook,
      `
      import { appendFileSync } from 'node:fs';
      import { basename } from 'node:path';
      if (basename(process.argv[1] ?? '') === 'build.mjs')
        process.once('exit', () => appendFileSync('build/app.js', ${JSON.stringify(marker)}));
    `,
    );
    const result = run([filter], env);
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /Reusing verified/);
    assert.equal(readFileSync(output, "utf8"), `built${marker}`);
    assert.throws(() => readFileSync(join(root, "test-results/electron-build.json")), {
      code: "ENOENT",
    });
  }
  const strict = run(["--reuse-build", filter], env);
  assert.notEqual(strict.status, 0, strict.output);
  assert.match(strict.output, /NODE_OPTIONS requires a fresh build/);
  assert.doesNotMatch(strict.output, /SELECTED_BODY/);
  const normal = run([filter]);
  assert.equal(normal.status, 0, normal.output);
  assert.doesNotMatch(normal.output, /Reusing verified/);
  assert.equal(readFileSync(output, "utf8"), "built");
});

test("an incomplete default catalog allows reuse and a complete catalog is fingerprinted", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  const catalog = join(root, ".cache/remote-hosts");
  const check = (reuse) => {
    const result = run([filter]);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.output.includes("Reusing verified current Electron build"), reuse);
  };
  mkdirSync(catalog, { recursive: true });
  check(false);
  check(true);
  for (const target of hostPlatforms) {
    const directory = join(catalog, target);
    mkdirSync(directory);
    writeFileSync(join(directory, "manifest.json"), "{}");
    if (target !== hostPlatforms.at(-1)) writeFileSync(join(directory, "foom-host.gz"), "fixture");
  }
  check(true);
  const archive = join(catalog, hostPlatforms.at(-1), "foom-host.gz");
  writeFileSync(archive, "complete");
  check(false);
  check(true);
  writeFileSync(archive, "changed");
  check(false);
  check(true);
  rmSync(archive);
  check(false);
  check(true);
});

test("replacing the selected Node license invalidates the build at the same Node version", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  const runtime = join(root, "test-results/runtime");
  const bin = process.platform === "win32" ? runtime : join(runtime, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, process.platform === "win32" ? "node.exe" : "node");
  cpSync(process.execPath, executable);
  const license = join(runtime, "LICENSE");
  writeFileSync(license, "Fixture license");

  const built = run([filter], {}, executable);
  assert.equal(built.status, 0, built.output);
  const reused = run([filter], {}, executable);
  assert.equal(reused.status, 0, reused.output);
  assert.match(reused.output, /Reusing verified current Electron build/);
  writeFileSync(license, "Updated fixture license");
  const rebuilt = run([filter], {}, executable);
  assert.equal(rebuilt.status, 0, rebuilt.output);
  assert.doesNotMatch(rebuilt.output, /Reusing verified/);
});

test("suite selection validates inventory, executes only selected files and rejects zero tests", (context) => {
  const { root, run } = fixture(context);
  writeFileSync(join(root, "tests/electron/two.test.js"), `throw Error('UNSELECTED_FILE');`);
  const selected = run(["--suite=one.test.js", "--test-name-pattern=^selected case$"]);
  assert.equal(selected.status, 0, selected.output);
  assert.doesNotMatch(selected.output, /UNSELECTED_FILE/);
  for (const args of [
    ["--suite=missing.test.js"],
    ["--suite=../one.test.js"],
    ["--packaged", "--suite=one.test.js"],
    ["--suite=one.test.js", "--test-name-pattern=absent"],
  ]) {
    assert.notEqual(run(args).status, 0);
  }
  writeFileSync(join(root, "tests/electron/empty.test.js"), "");
  const empty = run(["--suite=empty.test.js"]);
  assert.notEqual(empty.status, 0, empty.output);
  assert.match(empty.output, /No selected tests passed/);
  const failed = run(["--suite=two.test.js"]);
  assert.notEqual(failed.status, 0);
  assert.match(failed.output, /UNSELECTED_FILE/);
});

test("evidence helper creates nested destinations and rejects escaping paths", () => {
  const target = evidencePath("evidence-helper/nested/capture.png");
  assert.ok(target.endsWith(join("test-results", "evidence-helper", "nested", "capture.png")));
  writeFileSync(target, "fixture evidence");
  assert.equal(evidencePath(target), target);
  assert.equal(evidencePath("test-results/evidence-helper/nested/capture.png"), target);
  assert.throws(() => evidencePath("../escaped.png"), /must stay under/);
  assert.throws(() => evidencePath(join(tmpdir(), "escaped.png")), /must stay under/);
  rmSync(join(target, "../.."), { recursive: true, force: true });
});

for (const packaged of [false, true]) {
  for (const fails of [false, true]) {
    test(`worktree guard rejects leaked files after ${packaged ? "packaged" : "Electron"} ${fails ? "failure" : "success"}`, (t) => {
      const { root, run } = fixture(t);
      writeFileSync(join(root, "existing developer file.txt"), "keep me");
      const suite = packaged ? "packaged-smoke.js" : "one.test.js";
      writeFileSync(
        join(root, "tests/electron", suite),
        `
        const { test } = require('node:test');
        test('writes evidence', () => {
          require('node:fs').writeFileSync('leaked screenshot.png', 'evidence');
          ${fails ? "throw Error('fixture failure');" : ""}
        });
      `,
      );
      const result = run(packaged ? ["--packaged"] : []);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /Tests created untracked files outside/);
      assert.match(result.output, /leaked screenshot.png/);
      assert.doesNotMatch(result.output, /existing developer file.txt/);
      assert.equal(readFileSync(join(root, "existing developer file.txt"), "utf8"), "keep me");
    });
  }
}

test("worktree guard permits test-results and pre-existing untracked files", (t) => {
  const { root, run } = fixture(t);
  writeFileSync(join(root, "existing screenshot.png"), "keep me");
  writeFileSync(
    join(root, "tests/electron/one.test.js"),
    `
    const { test } = require('node:test');
    test('writes allowed evidence', () => {
      require('node:fs').mkdirSync('test-results/nested', { recursive: true });
      require('node:fs').writeFileSync('test-results/nested/capture.png', 'evidence');
    });
  `,
  );
  const result = run([]);
  assert.equal(result.status, 0, result.output);
});

test("worktree guard permits a temporary directory inside the checkout", (t) => {
  const { root, run } = fixture(t);
  const temporary = join(root, "temporary");
  mkdirSync(temporary);
  writeFileSync(
    join(root, "tests/electron/one.test.js"),
    `
    const { test } = require('node:test');
    test('writes temporary evidence', () => {
      require('node:fs').writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'capture.png'), 'evidence');
    });
  `,
  );
  const result = run([], { TMPDIR: temporary, TMP: temporary, TEMP: temporary });
  assert.equal(result.status, 0, result.output);
});

test("runner builds and verifies one same-revision host before cases and reuses it", {
  skip: process.platform === "win32",
}, (context) => {
  const { root, run } = fixture(context);
  if (process.platform !== "darwin") {
    const originals = join(
      root,
      `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}`,
    );
    mkdirSync(originals, { recursive: true });
    writeFileSync(join(originals, "pty.node"), "fixture pty");
  }
  writeFileSync(
    join(root, "tests/electron/one.test.js"),
    `
    const { test } = require('./test-shard.js');
    const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
    for (const name of ['first remote', 'second remote']) test(name, () => {
      require('node:assert/strict').equal(
        readFileSync('test-results/host-builds', 'utf8'), 'build\\n');
      require('node:assert/strict').equal(
        readFileSync('build/remote-host/foom-host', 'utf8'), 'fixture host');
      require('node:assert/strict').equal(
        readFileSync('build/remote-hosts/' + process.platform + '-' + process.arch + '/manifest.json', 'utf8'),
        readFileSync('build/remote-host/manifest.json', 'utf8'));
      mkdirSync('build/remote-host/native', { recursive: true, mode: 0o700 });
      writeFileSync('build/remote-host/native/pty.node', 'fixture pty', { mode: 0o600 });
      if (process.platform === 'darwin')
        writeFileSync('build/remote-host/native/spawn-helper', 'fixture helper', { mode: 0o700 });
    });
  `,
  );
  const fresh = run([]);
  assert.equal(fresh.status, 0, fresh.output);
  const reused = run([]);
  assert.equal(reused.status, 0, reused.output);
  assert.match(reused.output, /Reusing verified current Electron build/);
  assert.equal(readFileSync(join(root, "test-results/host-builds"), "utf8"), "build\n");
  assert.equal(readFileSync(join(root, "test-results/app-builds"), "utf8"), "build\n");
  writeFileSync(join(root, "build/remote-host/native/pty.node"), "corrupt pty");
  assert.match(run(["--reuse-build"]).output, /No current verified build/);
});

for (const failure of ["build", "revision", "gzip", "executable"]) {
  test(`runner rejects remote host ${failure} failure before running cases`, {
    skip: process.platform === "win32",
  }, (context) => {
    const { root, run } = fixture(context);
    const filter = "--test-name-pattern=^selected case$";
    assert.equal(run([filter]).status, 0);
    writeFileSync(join(root, "src/input.ts"), "changed");
    const result = run([filter], { TEST_HOST_FAILURE: failure });
    assert.notEqual(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /SELECTED_BODY/);
    assert.throws(() => readFileSync(join(root, "test-results/electron-build.json")), {
      code: "ENOENT",
    });
  });
}
test("a new checkout revision requires rebuilding even with unchanged build inputs", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  assert.equal(run([filter]).status, 0);
  gitSync(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "next revision",
    ],
    { cwd: root },
  );
  const stale = run(["--reuse-build", filter]);
  assert.notEqual(stale.status, 0, stale.output);
  assert.match(stale.output, /No current verified build/);
  assert.doesNotMatch(stale.output, /SELECTED_BODY/);
  const rebuilt = run([filter]);
  assert.equal(rebuilt.status, 0, rebuilt.output);
  assert.doesNotMatch(rebuilt.output, /Reusing verified/);
  assert.equal(readFileSync(join(root, "test-results/app-builds"), "utf8"), "build\nbuild\n");
  assert.match(run([filter]).output, /Reusing verified current Electron build/);
});

// Queue actions have an explicit accessible prefix; raw input in the dedicated
// security suite deliberately exercises races and must not use the settle helper.
function rawQueueClicks(source, file = "fixture.js") {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const lines = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "click" &&
      /Approve ·|Grant read-only access for/.test(node.expression.expression.getText(tree))
    )
      lines.push(tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return lines;
}
test("ordinary queue decision clicks use the trusted readiness helper", () => {
  assert.deepEqual(
    rawQueueClicks('page.getByRole("button", { name: "Approve · Remove" }).click();'),
    [1],
  );
  assert.deepEqual(
    rawQueueClicks(
      'await clickApproval(page, page.getByRole("button", { name: "Approve · Remove" }));',
    ),
    [],
  );
  const directory = new URL("../tests/electron/", import.meta.url);
  const failures = [];
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".js") || file === "approval-queue.test.js") continue;
    for (const line of rawQueueClicks(readFileSync(new URL(file, directory), "utf8"), file))
      failures.push(`${file}:${line}`);
  }
  assert.deepEqual(
    failures,
    [],
    "Reveal and settle queue decisions before native clicks; security regressions remain raw.",
  );
});
