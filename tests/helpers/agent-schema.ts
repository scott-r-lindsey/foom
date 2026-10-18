import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

type Schema = Record<string, unknown>;
const filename = "src/shared/agent-manifest-schema.ts";

/** Derive closed objects, required fields, enums and bounds from the wire parser. */
export function agentSchema(source = readFileSync(filename, "utf8")): Schema {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const toolTree = ts.createSourceFile(
    "tools.ts",
    readFileSync("src/shared/control-tool-classes.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const toolNames: string[] = [];
  const collectTools = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node)) toolNames.push(node.name.getText(toolTree));
    ts.forEachChild(node, collectTools);
  };
  collectTools(toolTree);
  const declarations = new Map<string, ts.FunctionDeclaration | ts.Expression>();
  for (const statement of tree.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name)
      declarations.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          declarations.set(declaration.name.text, declaration.initializer);
  }
  const text = (maxLength = 4096, minLength = 1): Schema => ({
    type: "string",
    minLength,
    maxLength,
    pattern: "^[^\\p{Cc}\\p{Cf}\\p{Co}\\p{Cs}\\u2028\\u2029]*$",
  });
  const primitive: Schema = {
    anyOf: [text(), { type: "number" }, { type: "boolean" }, { type: "null" }],
  };
  const defs: Record<string, Schema> = {};
  function value(node: ts.Node | undefined): unknown {
    if (!node) throw new Error("Missing schema argument");
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(value);
    if (node.getText(tree) === "Object.keys(CONTROL_TOOL_CLASSES)") return toolNames;
    if (node.getText(tree) === "Object.keys(CONTROL_TOOL_CLASSES).length") return toolNames.length;
    if (ts.isSpreadElement(node)) return value(node.expression);
    throw new Error(`Unsupported schema value: ${node.getText(tree)}`);
  }
  function number(node: ts.Node | undefined, fallback: number): number {
    const result = node ? value(node) : fallback;
    if (typeof result !== "number") throw new Error("Expected numeric bound");
    return result;
  }
  function parser(node: ts.Expression): Schema {
    if (ts.isIdentifier(node)) return named(node.text);
    if (ts.isCallExpression(node)) {
      // A curried parser is applied to (value, path).
      if (ts.isCallExpression(node.expression)) return parser(node.expression);
      const name = node.expression.getText(tree);
      const args = node.arguments;
      if (name === "optional" || name === "defaulted") return parser(required(args[0]));
      if (name === "array")
        return {
          type: "array",
          items: parser(required(args[0])),
          maxItems: number(args[1], 0),
          minItems: number(args[2], 0),
        };
      if (name === "literal") return { const: value(args[0]) };
      if (name === "enumeration")
        return {
          enum: args.flatMap((arg) =>
            ts.isSpreadElement(arg) ? value(arg.expression) : [value(arg)],
          ),
        };
      if (name === "text") return text(number(args[2], 4096), number(args[3], 1));
      if (name === "integer")
        return {
          type: "integer",
          maximum: number(args[2], Number.MAX_SAFE_INTEGER),
          minimum: number(args[3], 0),
        };
      if (name === "pattern") {
        const regex = required(args[2]).getText(tree);
        return { ...text(number(args[3], 4096)), pattern: regex.slice(1, regex.lastIndexOf("/")) };
      }
      return named(name);
    }
    throw new Error(`Unsupported parser: ${node.getText(tree)}`);
  }
  function required<T>(item: T | undefined): T {
    if (item === undefined) throw new Error("Missing parser expression");
    return item;
  }
  function object(call: ts.CallExpression, result: ts.ObjectLiteralExpression): Schema {
    const properties: Record<string, Schema> = {};
    for (const field of result.properties) {
      if (!ts.isPropertyAssignment(field)) throw new Error("Unsupported parser property");
      properties[field.name.getText(tree)] = parser(field.initializer);
    }
    return {
      type: "object",
      additionalProperties: false,
      required: value(call.arguments[2]),
      properties,
    };
  }
  function named(name: string): Schema {
    const builtin: Record<string, Schema> = {
      text: text(),
      integer: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      boolean: { type: "boolean" },
      primitive,
      id: { ...text(40), pattern: "^[a-z][a-z0-9-]*$" },
      localId: { ...text(40), pattern: "^[A-Za-z][A-Za-z0-9_-]*$" },
      flag: { ...text(64), pattern: "^--?[A-Za-z][A-Za-z0-9-]*$" },
      basename: {
        ...text(64),
        pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$",
        not: { pattern: "\\.[cC][mM][dD]$|\\.[bB][aA][tT]$|\\.[pP][sS]1$" },
      },
      relative: {
        ...text(100),
        description: "Safe relative file; foom config validate checks components and device names.",
      },
      multiline: { type: "string", maxLength: 16384 },
      versionText: { type: "string", maxLength: 256 },
      jsonValue: {},
    };
    if (builtin[name]) return required(builtin[name]);
    if (defs[name]) return { $ref: `#/$defs/${name}` };
    defs[name] = {};
    const declaration = required(declarations.get(name));
    let definition: Schema;
    const unions: Record<string, () => Schema> = {
      selectorKey: () => ({ anyOf: [{ type: "integer", minimum: 0, maximum: 63 }, text(64)] }),
      field: () => ({ anyOf: [text(64), named("selector")] }),
      testValue: () => ({ anyOf: [primitive, { type: "array", maxItems: 16, items: primitive }] }),
      abi: () => ({
        anyOf: [
          named("abiInteger"),
          {
            type: "object",
            additionalProperties: false,
            required: ["posix", "win32"],
            properties: { posix: named("abiInteger"), win32: named("abiInteger") },
          },
        ],
      }),
      aliases: () => ({
        type: "object",
        maxProperties: 8,
        propertyNames: text(128),
        additionalProperties: primitive,
      }),
      statusProbe: () => ({ anyOf: [{ const: "observed-health" }, named("argv")] }),
      argumentMatcher: () => {
        const calls: ts.CallExpression[] = [];
        const results: ts.ObjectLiteralExpression[] = [];
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && node.expression.getText(tree) === "object")
            calls.push(node);
          if (
            ts.isReturnStatement(node) &&
            node.expression &&
            ts.isObjectLiteralExpression(node.expression)
          )
            results.push(node.expression);
          ts.forEachChild(node, visit);
        };
        visit(declaration);
        return {
          oneOf: results.map((result, index) => object(required(calls[index + 1]), result)),
        };
      },
    };
    const union = unions[name];
    if (union) definition = union();
    else if (!ts.isFunctionDeclaration(declaration)) {
      definition =
        ts.isArrowFunction(declaration) && !ts.isBlock(declaration.body)
          ? parser(declaration.body)
          : parser(declaration);
    } else {
      const statements = required(declaration.body).statements;
      const result = statements.find(ts.isReturnStatement)?.expression;
      const binding = statements
        .filter(ts.isVariableStatement)
        .flatMap((statement) => [...statement.declarationList.declarations])
        .find((item) => item.name.getText(tree) === "d")?.initializer;
      if (result && ts.isObjectLiteralExpression(result) && binding && ts.isCallExpression(binding))
        definition = object(binding, result);
      else if (result) definition = parser(result);
      else throw new Error(`Unsupported parser function: ${name}`);
    }
    defs[name] = definition;
    return { $ref: `#/$defs/${name}` };
  }
  const root = named("v2");
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "foom:agent",
    title: "Foom agent v2",
    description:
      "Generated from agent-manifest-schema.ts. Run foom config validate for cross-field, template and security checks.",
    ...root,
    $defs: defs,
  };
}

// Regenerate with: node --experimental-strip-types tests/helpers/agent-schema.ts --write
if (process.argv.includes("--write"))
  writeFileSync(
    "src/shared/agent-plugin.schema.json",
    `${JSON.stringify(agentSchema(), null, 2)}\n`,
  );
