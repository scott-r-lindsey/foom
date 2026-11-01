import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, matchesGlob, resolve } from "node:path";
import { test } from "node:test";
import { lintFixtures } from "./lint-fixtures.mjs";

const config = JSON.parse(readFileSync(new URL("../.oxlintrc.json", import.meta.url), "utf8"));
const inventory = JSON.parse(
  readFileSync(new URL("lint-rule-inventory.json", import.meta.url), "utf8"),
);
const acceptedGaps = new Set(["no-dupe-args", "no-octal"]);
const aliases = new Set([
  "no-array-constructor",
  "no-unused-expressions",
  "no-unused-vars",
  "no-useless-constructor",
]);
function target(name) {
  if (name.startsWith("@typescript-eslint/")) {
    const rule = name.slice("@typescript-eslint/".length);
    return `${aliases.has(rule) ? "eslint" : "typescript"}/${rule}`;
  }
  if (name.startsWith("@eslint-react/")) return name.replace("@eslint-react/", "retained-react/");
  if (name.startsWith("react-hooks/")) return name.replace("react-hooks/", "retained-hooks/");
  return name.includes("/") ? name : `eslint/${name}`;
}
function effective(file) {
  const rules = { ...config.rules };
  for (const override of config.overrides) {
    if (override.files.some((pattern) => matchesGlob(file, pattern)))
      Object.assign(rules, override.rules);
  }
  return rules;
}

test("all 221 original rule severities/options survive except the two approved parser gaps", () => {
  assert.equal(Object.keys(inventory).length, 221);
  for (const [name, original] of Object.entries(inventory)) {
    if (acceptedGaps.has(name)) continue;
    const expected = structuredClone(original.config);
    if (name === "preserve-caught-error") delete expected[1].errorClassNames; // Native default is the same empty list.
    for (const file of original.files) {
      let actual = effective(file)[target(name)];
      if (actual === "error") actual = [2];
      assert.deepEqual(actual, expected, `${name} in ${file}`);
    }
  }
});

test("native safety fixtures reject bad programs and accept valid counterparts", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "foom-lint-parity-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        types: [],
      },
      include: ["*.ts"],
    }),
  );
  writeFileSync(join(root, "types.ts"), "export interface Token { key: string }");
  const overrides = [];
  const settings = effective("src/main/parity.ts");
  for (const [index, [rule, invalid, valid]] of lintFixtures.entries()) {
    assert.ok(settings[rule], `Missing production setting: ${rule}`);
    for (const [kind, code] of [
      ["invalid", invalid],
      ["valid", valid],
    ]) {
      const filename = `${kind}-${index}.ts`;
      writeFileSync(join(root, filename), `${code}\nexport {};\n`);
      overrides.push({ files: [filename], rules: { [rule]: settings[rule] } });
    }
  }
  writeFileSync(
    join(root, "lint.json"),
    JSON.stringify({
      categories: { correctness: "off" },
      plugins: ["typescript"],
      options: { typeAware: true },
      overrides,
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      resolve("node_modules/oxlint/bin/oxlint"),
      "--config",
      join(root, "lint.json"),
      "--format=json",
      "--deny-warnings",
      root,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const { diagnostics } = JSON.parse(result.stdout);
  for (const [index, [rule]] of lintFixtures.entries()) {
    await context.test(`${index}: ${rule}`, () => {
      const expectedCode = rule.replace("/", "(") + ")";
      const rejected = diagnostics.filter(
        (item) => basename(item.filename) === `invalid-${index}.ts`,
      );
      const accepted = diagnostics.filter(
        (item) => basename(item.filename) === `valid-${index}.ts`,
      );
      assert.ok(
        rejected.some((item) => item.code === expectedCode),
        JSON.stringify(rejected),
      );
      assert.deepEqual(accepted, []);
    });
  }
});

test("the package graph and hook use only Oxlint as the linter", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(manifest.devDependencies.eslint, undefined);
  assert.equal(manifest.devDependencies["typescript-eslint"], undefined);
  assert.equal(manifest.scripts.lint, "oxlint . --deny-warnings");
  assert.equal(config.options.typeAware, true);
  assert.equal(config.options.reportUnusedDisableDirectives, "warn");
  assert.doesNotMatch(
    readFileSync("pnpm-lock.yaml", "utf8"),
    /^ {2}(?:eslint|typescript-eslint)@/m,
  );
  assert.match(readFileSync("scripts/pre-commit.mjs", "utf8"), /\["run", "check"\]/);
});

test("the accepted sloppy-CommonJS gaps do not extend to Forge or ESM files", () => {
  assert.match(readFileSync("forge.config.js", "utf8"), /^"use strict";/);
  const root = mkdtempSync(join(tmpdir(), "foom-lint-parser-"));
  try {
    mkdirSync(join(root, "esm"));
    writeFileSync(join(root, "lint.json"), JSON.stringify({ categories: { correctness: "off" } }));
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
          target: "ES2023",
        },
        include: ["*.ts"],
      }),
    );
    const run = (file) =>
      spawnSync(
        process.execPath,
        [resolve("node_modules/oxlint/bin/oxlint"), "--config", join(root, "lint.json"), file],
        { encoding: "utf8" },
      );
    for (const [bad, compilerError] of [
      ["function f(a, a) { return a; } f(1, 2);", /Duplicate identifier/],
      ["const value = 071; console.log(value);", /Octal literals are not allowed/],
    ]) {
      writeFileSync(join(root, "sloppy.js"), bad);
      writeFileSync(join(root, "esm", "strict.mjs"), bad);
      writeFileSync(join(root, "strict.js"), `"use strict";\n${bad}`);
      assert.equal(run(join(root, "sloppy.js")).status, 0);
      assert.equal(run(join(root, "esm", "strict.mjs")).status, 1);
      assert.equal(run(join(root, "strict.js")).status, 1);
      writeFileSync(join(root, "strict.ts"), `${bad}\nexport {};`);
      const compiler = spawnSync(
        process.execPath,
        [resolve("node_modules/typescript/bin/tsc"), "--project", root],
        { encoding: "utf8" },
      );
      assert.notEqual(compiler.status, 0);
      assert.match(compiler.stdout, compilerError);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("warnings from retained JavaScript safety rules fail the authoritative gate", () => {
  const root = mkdtempSync(join(tmpdir(), "foom-lint-warning-"));
  try {
    writeFileSync(
      join(root, "input.tsx"),
      'export const view = <iframe sandbox="allow-scripts allow-same-origin" />;',
    );
    writeFileSync(
      join(root, "lint.json"),
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [
          {
            name: "retained-react",
            specifier: resolve("node_modules/@eslint-react/eslint-plugin/dist/index.js"),
          },
        ],
        rules: { "retained-react/dom-no-unsafe-iframe-sandbox": "warn" },
      }),
    );
    const args = [
      resolve("node_modules/oxlint/bin/oxlint"),
      "--config",
      join(root, "lint.json"),
      join(root, "input.tsx"),
    ];
    const ordinary = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.match(ordinary.stdout, /dom-no-unsafe-iframe-sandbox/);
    const denied = spawnSync(process.execPath, [...args, "--deny-warnings"], { encoding: "utf8" });
    assert.equal(denied.status, 1, denied.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unused suppression comments retain the former warning and deny-warnings failure", () => {
  const root = mkdtempSync(join(tmpdir(), "foom-lint-directive-"));
  try {
    writeFileSync(
      join(root, "input.js"),
      "// oxlint-disable-next-line no-debugger\nconsole.log('safe');",
    );
    writeFileSync(
      join(root, "lint.json"),
      JSON.stringify({
        categories: { correctness: "off" },
        options: { reportUnusedDisableDirectives: config.options.reportUnusedDisableDirectives },
        rules: { "eslint/no-debugger": "error" },
      }),
    );
    const args = [
      resolve("node_modules/oxlint/bin/oxlint"),
      "--config",
      join(root, "lint.json"),
      join(root, "input.js"),
    ];
    const ordinary = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.match(ordinary.stdout, /Unused oxlint-disable directive/);
    const denied = spawnSync(process.execPath, [...args, "--deny-warnings"], { encoding: "utf8" });
    assert.equal(denied.status, 1, denied.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
