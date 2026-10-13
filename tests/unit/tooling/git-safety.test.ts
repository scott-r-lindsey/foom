import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

// Inspect calls rather than text so comments and embedded fake-agent scripts are ignored.
// Track renamed imports and promisified functions as well as member calls.
function directGitCalls(source: string): number[] {
  const file = ts.createSourceFile(
    "test.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const lines: number[] = [];
  const launchers = new Set(["execFile", "execFileSync", "spawn", "spawnSync"]);
  function launcher(node: ts.Node): boolean {
    return (
      (ts.isIdentifier(node) && launchers.has(node.text)) ||
      (ts.isPropertyAccessExpression(node) && launchers.has(node.name.text)) ||
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "promisify" &&
        !!node.arguments[0] &&
        launcher(node.arguments[0]))
    );
  }
  function aliases(node: ts.Node) {
    if (ts.isImportSpecifier(node) && node.propertyName && launchers.has(node.propertyName.text))
      launchers.add(node.name.text);
    if (
      ts.isBindingElement(node) &&
      node.propertyName &&
      ts.isIdentifier(node.propertyName) &&
      launchers.has(node.propertyName.text) &&
      ts.isIdentifier(node.name)
    )
      launchers.add(node.name.text);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      launcher(node.initializer)
    )
      launchers.add(node.name.text);
    ts.forEachChild(node, aliases);
  }
  aliases(file);
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && launcher(node.expression)) {
      const executable = node.arguments[0];
      if (
        executable &&
        (ts.isStringLiteral(executable) || ts.isNoSubstitutionTemplateLiteral(executable)) &&
        /^(?:.*[/\\])?git(?:\.exe)?$/i.test(executable.text)
      ) {
        lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return lines;
}
// A reported call needs a literal executable named git or git.exe, alone or after a path
// separator, so its source text has a quote or separator, that name, then a closing quote,
// unless an escape sequence spells a letter of it. Skipping other files gives the same result
// and keeps the scan fast under coverage.
function mayLaunchGit(source: string): boolean {
  return (
    /["'`/\\]git(?:\.exe)?["'`]/i.test(source) ||
    /\\(?:x|u00|u\{0*)(?:47|49|54|67|69|74)/i.test(source)
  );
}
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
test("detects direct Git launches, including aliases and member calls", () => {
  for (const call of [
    "execFile",
    "execFileSync",
    "spawn",
    "spawnSync",
    "child.spawn",
    "require('node:child_process').execFileSync",
  ]) {
    expect(directGitCalls(`${call}('git', ['init']);`)).toEqual([1]);
  }
  expect(
    directGitCalls(
      "import {execFile as run} from 'node:child_process'; const execute = promisify(run); execute('git', []);",
    ),
  ).toEqual([1]);
  expect(directGitCalls("spawn(`git`, []); spawn('git.exe', []); ")).toEqual([1, 1]);
  expect(directGitCalls("// spawn('git', [])\ngitSync(['init']); spawn('node', []);")).toEqual([]);
});
test("only skips sources that cannot name git as a literal executable", () => {
  for (const source of [
    "spawn('git', [])",
    'spawn("/usr/bin/git", [])',
    "spawn(`GIT.EXE`, [])",
    "spawn('g\\x69t', [])",
    "spawn('\\u0067it', [])",
    "spawn('gi\\u{74}', [])",
    "spawn('C:\\\\Program Files\\\\Git\\\\git.exe', [])",
  ]) {
    expect(mayLaunchGit(source)).toBe(true);
    expect(directGitCalls(source)).toEqual([1]);
  }
  expect(
    mayLaunchGit("gitSync(['init']); spawn('node', ['git-like', '\\x1b[0m', 'remote.git'])"),
  ).toBe(false);
});
test("all test Git launches use the shared isolation helper", () => {
  const targets = [
    ...files("tests"),
    ...files("scripts").filter((path) => path.endsWith(".test.mjs")),
  ];
  const violations = targets
    .filter(
      (path) =>
        /\.(?:[cm]?js|tsx?)$/.test(path) &&
        relative(".", path).replaceAll("\\", "/") !== "tests/helpers/git.js",
    )
    .flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return mayLaunchGit(source)
        ? directGitCalls(source).map((line) => `${path}:${String(line)}`)
        : [];
    });
  expect(violations).toEqual([]);
});
