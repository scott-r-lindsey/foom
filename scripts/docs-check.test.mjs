import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gitSync } from "../tests/helpers/git.js";
import { checkDocs, mapRows, parseDocument, readingFor } from "./docs-check.mjs";

const checker = path.resolve("scripts/docs-check.mjs");
const mapHeader = "| Owner | Responsibility | Reading |\n| --- | --- | --- |\n";
function fixture(t, extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "foom-docs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contents = {
    "docs/map.md": `${mapHeader}| \`src/main/entry.ts\` | Entry | [Area](areas/app.md#start) |\n`,
    "docs/areas/app.md": "# Start\n",
    "src/main/entry.ts": "export {};\n",
    ...extra,
  };
  for (const [file, content] of Object.entries(contents)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return { root, files: Object.keys(contents) };
}

test("mapped declarations and assets use full paths, directory prefixes and union matching", (t) => {
  const { root, files } = fixture(t, {
    "docs/map.md": `${mapHeader}| \`src/main/entry.ts\`, \`src/shared/*.d.ts\`, \`src/art/\` | Base | [App](areas/app.md) |
| \`src/shared/**\` | Feature | [Start](areas/app.md#start), [App](areas/app.md) |
`,
    "src/shared/nested/view.d.ts": "",
    "src/shared/view.d.ts": "",
    "src/art/sky.png": "asset",
    "src/main/AGENTS.md": "Rules",
    "src/main/CLAUDE.md": "@AGENTS.md",
  });
  assert.deepEqual(checkDocs(root, files), []);
  const rows = mapRows(parseDocument(readFileSync(path.join(root, "docs/map.md"), "utf8")).tokens);
  assert.deepEqual(readingFor("src/shared/view.d.ts", rows), [
    "areas/app.md",
    "areas/app.md#start",
  ]);
  assert.deepEqual(readingFor("src/shared/nested/view.d.ts", rows), [
    "areas/app.md#start",
    "areas/app.md",
  ]);
  assert.deepEqual(readingFor("src/artwork/sky.png", rows), []);
});

test("a new unmapped source fails even if mentioned in responsibility prose", (t) => {
  const { root, files } = fixture(t, {
    "src/main/new-feature.ts": "export {};",
    "README.md": "Source: `src/main/new-feature.ts`",
  });
  assert.deepEqual(checkDocs(root, files), [
    "docs/map.md: unmapped source: src/main/new-feature.ts",
  ]);
});

test("a broken required area link and an invalid anchor fail", (t) => {
  const { root, files } = fixture(t, {
    "docs/map.md": `${mapHeader}| \`src/main/entry.ts\` | Entry | [Missing](areas/missing.md), [Anchor](areas/app.md#gone) |`,
  });
  assert.deepEqual(checkDocs(root, files), [
    "docs/map.md: missing local link target: areas/missing.md",
    "docs/map.md: missing anchor: areas/app.md#gone",
  ]);
});

test("stale, abbreviated and reading-free owner rows fail", (t) => {
  const { root, files } = fixture(t, {
    "docs/map.md": `${mapHeader}| \`src/main/entry.ts\`, \`entry.ts\`, \`src/missing/\` | Entry | No links |`,
  });
  assert.deepEqual(checkDocs(root, files), [
    "docs/map.md: owner row has no required reading links",
    "docs/map.md: invalid full-path source pattern entry.ts",
    "docs/map.md: source pattern matches no tracked files: src/missing/",
    "docs/map.md: unmapped source: src/main/entry.ts",
  ]);
});

test("Markdown links, references, images and HTML anchors are checked, code and comments are inert", (t) => {
  const { root, files } = fixture(t, {
    "README.md": `# Read *this* and \`that\`!
# Read *this* and \`that\`!
Underlined heading
==================
<a id="legacy"></a>
[inline](#read-this-and-that) [duplicate](#read-this-and-that-1)
[setext](#underlined-heading) [old](#legacy)
[reference][area]
[area]: docs/areas/app.md#start "Area title"
![image](src/main/entry.ts)
<https://example.invalid/unreachable>
\`[code](missing-inline.md)\`

    [code](missing-indented.md)

~~~md
[code](missing-fenced.md)
<a href="missing-code.md"></a>
~~~
<!-- [comment](missing-comment.md) <a href="missing-comment.md"></a> -->
<a href="docs/areas/app.md#start">HTML</a>
`,
  });
  assert.deepEqual(checkDocs(root, files), []);
  writeFileSync(
    path.join(root, "README.md"),
    "[bad][x]\n\n[x]: gone.md\n![bad](gone.png)\n<a href='gone.html'>bad</a>",
  );
  assert.deepEqual(checkDocs(root, files), [
    "README.md: missing local link target: gone.md",
    "README.md: missing local link target: gone.png",
    "README.md: missing local link target: gone.html",
  ]);
});

test("balanced link parentheses, encoded paths, URL queries and Unicode anchors work", (t) => {
  const { root, files } = fixture(t, {
    "docs/space (one).md": "# Café & tea\n",
    "README.md":
      "# Readme\n[one](docs/space%20(one).md#caf%C3%A9--tea)\n[root](/docs/space%20(one).md?raw=1#caf%C3%A9--tea)\n[query](?raw=1#readme)\n[fragment](#readme)\n[bad](%ZZ)\n[outside](../outside.md)",
  });
  assert.deepEqual(checkDocs(root, files), [
    "README.md: missing local link target: %25ZZ",
    "README.md: missing local link target: ../outside.md",
  ]);
});

test("hostile preview fixtures, references and generated output are excluded", (t) => {
  const extra = Object.fromEntries(
    [
      "tests/fixtures/previews/hostile.md",
      "inspiration/sample.md",
      "docs/mockups/sample.md",
      "spikes/sample.md",
      "build/generated.md",
      "out/generated.md",
      "coverage/generated.md",
      "node_modules/sample.md",
      "test-results/sample.md",
      "playwright-report/sample.md",
    ].map((file) => [file, "[attack](../../missing.md#missing)"]),
  );
  const { root, files } = fixture(t, extra);
  assert.deepEqual(checkDocs(root, files), []);
});

test("CLI uses the tracked inventory and returns nonzero for a new tracked feature", (t) => {
  const { root } = fixture(t, { "src/main/new-feature.ts": "" });
  gitSync(["init", "-q"], { cwd: root });
  gitSync(["add", "."], { cwd: root });
  const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /unmapped source: src\/main\/new-feature\.ts/);
  gitSync(["rm", "--cached", "src/main/new-feature.ts"], { cwd: root });
  const passed = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
  assert.equal(passed.status, 0, passed.stderr);
});

test("repository representatives select their real feature docs in one hop", () => {
  const rows = mapRows(parseDocument(readFileSync("docs/map.md", "utf8")).tokens);
  for (const [file, expected] of [
    ["src/renderer/about/about-dialog.tsx", "areas/renderer.md#flight-art-and-about-670-725"],
    ["src/main/workspace/review-snapshot.ts", "areas/orchestration.md"],
    ["src/shared/bundled-forges/github.json", "areas/forge.md"],
    ["src/renderer/board/action-log-view.tsx", "areas/action-log.md"],
    ["src/node-common/control-validation.ts", "areas/control-validation.md"],
    ["src/node-common/review.ts", "areas/handoffs.md"],
    ["src/shared/environment-rules.ts", "areas/agent-launch.md#launch-environment-215"],
    ["src/shared/sound-files.ts", "areas/sound.md"],
    ["src/shared/bundled-agents/codex.json", "areas/providers.md"],
    ["src/main/profile.ts", "areas/application.md"],
    ["src/main/installer.ts", "areas/application.md"],
    ["src/manual/manual.html", "areas/previews.md#bundled-manual-root"],
  ])
    assert.ok(readingFor(file, rows).includes(expected), `${file} must select ${expected}`);
});

test("tracked document aliases and link targets cannot escape the repository", (t) => {
  const { root, files } = fixture(t, {
    "README.md": "[outside](alias.md#outside)",
  });
  const outside = mkdtempSync(path.join(tmpdir(), "foom-docs-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, "outside.md"), "# Outside\n[do not parse](missing-outside.md)");
  symlinkSync(path.join(outside, "outside.md"), path.join(root, "alias.md"), "file");
  files.push("alias.md");
  assert.deepEqual(checkDocs(root, files), [
    "README.md: local link target escapes repository: alias.md#outside",
    "alias.md: document escapes repository",
  ]);
  // A symlinked ancestor must not bypass the same containment check.
  symlinkSync(
    outside,
    path.join(root, "outside-dir"),
    process.platform === "win32" ? "junction" : "dir",
  );
  writeFileSync(path.join(root, "README.md"), "[outside](outside-dir/outside.md#outside)");
  assert.deepEqual(checkDocs(root, files), [
    "README.md: local link target escapes repository: outside-dir/outside.md#outside",
    "alias.md: document escapes repository",
  ]);
});

test("tracked aliases and anchor links preserve canonical preview exclusions", (t) => {
  const { root, files } = fixture(t, {
    "README.md": "[fixture](alias.md#missing) [directory](alias-dir/hostile.md#missing)",
    "tests/fixtures/previews/hostile.md": "[attack](missing-hostile.md#missing)",
  });
  symlinkSync(
    path.join(root, "tests/fixtures/previews/hostile.md"),
    path.join(root, "alias.md"),
    "file",
  );
  symlinkSync(
    path.join(root, "tests/fixtures/previews"),
    path.join(root, "alias-dir"),
    process.platform === "win32" ? "junction" : "dir",
  );
  files.push("alias.md", "alias-dir/hostile.md");
  assert.deepEqual(checkDocs(root, files), []);
});

test("HTML href and src attributes support unquoted values at real attribute boundaries", (t) => {
  const { root, files } = fixture(t, {
    "README.md": `<a title="ignore > href='ignored-title.md'" href=missing-page.md>broken</a>
<img src=missing-image.png>
<a HREF='missing-single.md'>single</a>
<a href="missing-double.md">double</a>
<a data-href="ignored.md" data-src=ignored.png title="see href=ignored-title.md">inert</a>
<a href=/docs/areas/app.md#start>valid root link</a>
<img src=/src/main/entry.ts>
<a id=legacy></a>
[legacy](#legacy)
`,
  });
  assert.deepEqual(checkDocs(root, files), [
    "README.md: missing local link target: missing-page.md",
    "README.md: missing local link target: missing-image.png",
    "README.md: missing local link target: missing-single.md",
    "README.md: missing local link target: missing-double.md",
  ]);
});
