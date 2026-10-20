import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, test } from "vitest";
import { help } from "../../../src/cli/help";

/** Read dispatch syntax, so a new parser branch must also be documented. */
function dispatched(file: string, parameter: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  function visit(node: ts.Node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    ) {
      for (const [left, right] of [
        [node.left, node.right],
        [node.right, node.left],
      ]) {
        if (left?.getText(source) === parameter && right && ts.isStringLiteral(right))
          names.add(right.text);
      }
    }
    if (ts.isSwitchStatement(node) && node.expression.getText(source) === parameter) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression))
          names.add(clause.expression.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...names].sort();
}

function documented(lines: readonly string[]): string[] {
  return [
    ...new Set(
      lines.flatMap((line) => line.split(" | ").map((entry) => entry.split(" ")[0] ?? "")),
    ),
  ].sort();
}

test("help lists every control parser command, including alternate forms", () => {
  const lines = help().split("\n");
  const entries = [
    lines[0]?.replace("foom [--json] ", ""),
    lines[1]?.replace("Agents: ", "").replace(" (also with --json)", ""),
    lines[3]?.replace("Orchestrators only: ", ""),
  ];
  expect(documented(entries.map((entry) => entry ?? ""))).toEqual(
    dispatched("src/cli/commands.ts", "name"),
  );
});

test("help lists every probe action and top-level console route", () => {
  const line =
    help()
      .split("\n")
      .find((entry) => entry.startsWith("Config sessions only: foom agent probe ")) ?? "";
  const configActions = dispatched("src/cli/execute.ts", "words[1]").map((name) =>
    name === "status" ? "config-status" : name,
  );
  expect(documented([line.replace("Config sessions only: foom agent probe ", "")])).toEqual(
    dispatched("src/node-common/agent-probe.ts", "action").filter(
      (name) => !configActions.includes(name),
    ),
  );
  for (const route of dispatched("src/cli/execute.ts", "words[1]"))
    expect(help()).toContain(`${route === "probe" ? "agent" : "config"} ${route}`);
  const consoleRoutes = dispatched("src/cli/execute.ts", "words[0]");
  for (const route of consoleRoutes) expect(help()).toContain(route);
});
