import { readFileSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { compileFunction, runInNewContext } from "node:vm";

const reservedBindings = new Set([
  "require",
  "exports",
  "module",
  "process",
  "Map",
  "Set",
  "WeakMap",
  "Error",
  "undefined",
  "__dirname",
  "__filename",
  "record",
  "group",
]);
const fixturePackages = new Set(["@axe-core/playwright", "@playwright/test"]);
const fixtureBuiltins = new Set([
  "node:assert/strict",
  "node:child_process",
  "node:crypto",
  "node:events",
  "node:fs",
  "node:fs/promises",
  "node:net",
  "node:os",
  "node:path",
  "node:util",
  "node:zlib",
  "node:timers/promises",
  "node:perf_hooks",
]);
const testApi = new Map([
  ["describe", "describe"],
  ["afterEach", "afterEach"],
]);
const shardApi = new Map([["test", "test"]]);

// The projection contains only registration calls and expressions over literal
// data. Check the original with V8 too: the TypeScript parser accepts syntax
// such as a break outside a loop and TypeScript syntax in otherwise valid JS.
export function discoverStaticRegistrations(files) {
  const require = createRequire(import.meta.url);
  const ts = require("typescript");
  const modules = new Map();
  const packages = new Map();
  const shardSources = new Map(
    ["test-shard.js", "shard-assignment.js", "shard-plan.json"].map((name) => [
      `./${name}`,
      readFileSync(new URL(`../tests/electron/${name}`, import.meta.url), "utf8"),
    ]),
  );
  const fail = (detail = "") => {
    throw new Error(`Unproven Electron registration ${detail}`);
  };
  const unwrap = (node) => {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    return node;
  };
  const literal = (node) =>
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
      node.kind,
    );
  const functionValue = (node) => ts.isArrowFunction(node) || ts.isFunctionExpression(node);
  const nameOf = (node) =>
    node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : fail();

  function bind(pattern, value, bindings) {
    if (ts.isIdentifier(pattern)) {
      if (bindings.has(pattern.text) || reservedBindings.has(pattern.text)) fail(pattern.text);
      bindings.set(pattern.text, value);
      return;
    }
    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element) || element.initializer || element.dotDotDotToken) fail();
      const property = ts.isObjectBindingPattern(pattern)
        ? nameOf(element.propertyName ?? element.name)
        : undefined;
      bind(
        element.name,
        value instanceof Map ? value.get(property) : value === "data" ? "data" : undefined,
        bindings,
      );
    }
  }

  function syntax(file) {
    const extension = extname(file);
    if (extension === ".js") {
      const manifest = findPackageJSON(pathToFileURL(file));
      if (manifest && basename(manifest) === "package.json") {
        if (!packages.has(manifest))
          packages.set(manifest, JSON.parse(readFileSync(manifest, "utf8")).type);
        if (packages.get(manifest) === "module") fail(file);
      }
    } else if (extension !== ".cjs") fail(file);
    const text = readFileSync(file, "utf8");
    // A CJS wrapper also checks early errors involving Node's implicit bindings.
    compileFunction(text, ["exports", "require", "module", "__filename", "__dirname"], {
      filename: file,
    });
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    if (source.parseDiagnostics.length > 0) fail();
    return source;
  }

  function loadModule(specifier, file, suite) {
    if (specifier === "node:test") return testApi;
    if (specifier === "./test-shard.js" && suite) {
      const helper = createRequire(file).resolve(specifier);
      if (!modules.has(helper)) {
        const resolveShardFile = createRequire(helper).resolve;
        for (const [name, source] of shardSources)
          if (readFileSync(resolveShardFile(name), "utf8") !== source) fail(helper);
        syntax(helper);
        modules.set(helper, shardApi);
      }
      return modules.get(helper);
    }
    if (fixtureBuiltins.has(specifier) || fixturePackages.has(specifier)) {
      const resolved = createRequire(file).resolve(specifier);
      if (fixturePackages.has(specifier) && resolved !== require.resolve(specifier)) fail();
      if (specifier === "node:child_process") return new Map([["execFile", "execFile"]]);
      if (specifier === "node:path") return new Map([["resolve", "path.resolve"]]);
      if (specifier === "node:util") return new Map([["promisify", "promisify"]]);
      if (specifier === "@playwright/test")
        return new Map([["expect", new Map([["configure", "configure"]])]]);
      return;
    }
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) fail(specifier);
    const resolved = createRequire(file).resolve(specifier);
    if (!modules.has(resolved)) {
      // Modules may export values used by test bodies. Any registration during
      // module initialization or cyclic initialization is outside the proof.
      modules.set(resolved, null);
      modules.set(resolved, scan(resolved, false).exports);
    }
    const value = modules.get(resolved);
    if (value === null) fail();
    return value;
  }

  const binary = new Set([
    ts.SyntaxKind.PlusToken,
    ts.SyntaxKind.AsteriskToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
  ]);

  // Check eagerly evaluated expressions. Functions are inert here unless a
  // call is explicitly authorized below. Types track the handful of helpers
  // called at module scope, so an unrelated function with the same name cannot
  // be mistaken for a known operation.
  function expression(input, context, dataOnly = false) {
    const node = unwrap(input);
    if (literal(node)) return ts.isStringLiteralLike(node) ? "string" : "data";
    if (ts.isIdentifier(node)) {
      if (dataOnly ? !context.projected.has(node.text) : !context.bindings.has(node.text))
        fail(node.text);
      return context.bindings.get(node.text);
    }
    if (!dataOnly && functionValue(node)) {
      if (
        !ts.isBlock(node.body) &&
        node.parameters.every((p) => ts.isIdentifier(p.name) && !p.initializer && !p.dotDotDotToken)
      ) {
        const bindings = new Map(context.bindings);
        for (const param of node.parameters) bindings.set(param.name.text, "data");
        // Analyze simple arithmetic fixture functions without executing them.
        if (
          ts.isBinaryExpression(node.body) &&
          node.body.operatorToken.kind === ts.SyntaxKind.AsteriskToken &&
          [node.body.left, node.body.right].every(
            (part) => ts.isIdentifier(part) && bindings.get(part.text) === "data",
          )
        )
          return "arithmetic";
      }
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const item of node.elements) {
        if (ts.isSpreadElement(item)) {
          if (expression(item.expression, context, dataOnly) !== "array") fail();
        } else {
          expression(item, context, dataOnly);
        }
      }
      return "array";
    }
    if (ts.isObjectLiteralExpression(node)) {
      const properties = new Map();
      for (const prop of node.properties) {
        if (dataOnly && ts.isSpreadAssignment(prop)) {
          if (expression(prop.expression, context, true) !== "data") fail();
          continue;
        }
        const name = nameOf(prop.name);
        if (name === "__proto__") fail();
        if (ts.isPropertyAssignment(prop))
          properties.set(name, expression(prop.initializer, context, dataOnly));
        else if (ts.isShorthandPropertyAssignment(prop) && !prop.objectAssignmentInitializer)
          properties.set(name, expression(prop.name, context, dataOnly));
        else fail();
      }
      return properties;
    }
    if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
      if (
        !dataOnly &&
        node.expression.getText(context.source) === "process" &&
        node.name.text === "platform" &&
        !context.bindings.has("process")
      )
        return "data";
      const receiver = expression(node.expression, context, dataOnly);
      if (receiver instanceof Map) return receiver.get(node.name.text);
      if (receiver === "string" && ["replace", "repeat"].includes(node.name.text))
        return node.name.text;
      if (
        receiver === "data" &&
        !["__proto__", "constructor", "prototype"].includes(node.name.text)
      )
        return "data";
      if (receiver === "promisify" && node.name.text === "custom") return;
      // Unknown properties of the opaque builtin or fixture exports are used
      // only in non-registration code. Computed properties are unsupported.
      if (!dataOnly) return;
      return fail();
    }
    if (ts.isBinaryExpression(node) && binary.has(node.operatorToken.kind)) {
      const left = expression(node.left, context, dataOnly);
      const right = expression(node.right, context, dataOnly);
      if (!["string", "data"].includes(left) || !["string", "data"].includes(right)) fail();
      return left === "string" && node.operatorToken.kind === ts.SyntaxKind.PlusToken
        ? "string"
        : "data";
    }
    if (ts.isConditionalExpression(node)) {
      if (!["data", "string"].includes(expression(node.condition, context, dataOnly))) fail();
      const yes = expression(node.whenTrue, context, dataOnly);
      const no = expression(node.whenFalse, context, dataOnly);
      return yes === no ? yes : undefined;
    }
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans)
        if (!["string", "data"].includes(expression(span.expression, context, dataOnly))) fail();
      return "string";
    }
    if (
      dataOnly &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      !node.questionDotToken &&
      !node.expression.questionDotToken &&
      ["map", "flatMap"].includes(node.expression.name.text)
    ) {
      const [callback] = node.arguments;
      if (
        node.arguments.length !== 1 ||
        !ts.isArrowFunction(callback) ||
        callback.modifiers?.length ||
        ts.isBlock(callback.body) ||
        callback.parameters.length !== 1 ||
        expression(node.expression.expression, context, true) !== "array"
      )
        fail();
      const [parameter] = callback.parameters;
      if (parameter.initializer || parameter.dotDotDotToken) fail();
      const bindings = new Map();
      bind(parameter.name, "data", bindings);
      const nested = {
        ...context,
        bindings: new Map([...context.bindings, ...bindings]),
        projected: new Set([...context.projected, ...bindings.keys()]),
      };
      const result = expression(callback.body, nested, true);
      if (node.expression.name.text === "flatMap" && result !== "array") fail();
      return "array";
    }
    if (!dataOnly && ts.isCallExpression(node) && !node.questionDotToken) {
      const target = node.expression.getText(context.source);
      if (["require", "process.getBuiltinModule"].includes(target)) {
        const [specifier] = node.arguments;
        if (
          node.arguments.length !== 1 ||
          !ts.isStringLiteral(specifier) ||
          (target !== "require" &&
            (specifier.text !== "node:os" || context.bindings.has("process")))
        )
          fail();
        return loadModule(specifier.text, context.file, context.suite);
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "join" &&
        ts.isArrayLiteralExpression(node.expression.expression)
      ) {
        if (
          node.expression.expression.elements.some(
            (item) => expression(item, context) !== "string",
          ) ||
          node.arguments.length !== 1 ||
          !ts.isStringLiteral(node.arguments[0])
        )
          fail();
        return "string";
      }
      const operation = expression(node.expression, context);
      const [argument] = node.arguments;
      if (
        operation === "promisify" &&
        node.arguments.length === 1 &&
        expression(argument, context) === "execFile"
      )
        return;
      if (
        operation === "configure" &&
        node.arguments.length === 1 &&
        ts.isObjectLiteralExpression(argument) &&
        expression(argument, context).get("timeout") === "data"
      )
        return;
      if (
        operation === "arithmetic" &&
        node.arguments.length === 1 &&
        expression(argument, context) === "data"
      )
        return "data";
      if (
        ["path.resolve", "replace"].includes(operation) &&
        node.arguments.every((arg) => expression(arg, context) === "string")
      )
        return "string";
      if (
        operation === "repeat" &&
        node.arguments.length === 1 &&
        ts.isNumericLiteral(argument) &&
        Number(argument.text) <= 10_000
      )
        return "string";
    }
    if (
      !dataOnly &&
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["Map", "Set", "WeakMap"].includes(node.expression.text) &&
      !context.bindings.has(node.expression.text)
    ) {
      const args = node.arguments ?? [];
      if (args.length === 0) return;
      if (
        node.expression.text === "Set" &&
        args.length === 1 &&
        ts.isArrayLiteralExpression(args[0]) &&
        args[0].elements.every(literal)
      )
        return;
      return fail();
    }
    return fail(node.getText(context.source).slice(0, 100));
  }

  function registration(node, context) {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.questionDotToken)
      fail();
    const kind = context.bindings.get(node.expression.text);
    const args = [...node.arguments];
    const body = args.pop();
    if (!body || !functionValue(body)) fail();
    if (kind === "afterEach" && args.length === 0) return "";
    if (
      !context.suite ||
      !["test", "describe"].includes(kind) ||
      args.length < 1 ||
      args.length > 2
    )
      fail();
    const [name, options] = args;
    expression(name, context, true);
    if (options) expression(options, context);
    const nameText = name.getText(context.source);
    if (kind === "test") return `record(${nameText});`;
    if (body.modifiers?.length || body.asteriskToken || body.parameters.length) fail();
    const nested = {
      ...context,
      bindings: new Map(context.bindings),
      projected: new Set(context.projected),
    };
    const children = ts.isBlock(body.body)
      ? body.body.statements.map((child) => statement(child, nested)).join("\n")
      : registration(body.body, nested);
    return `group(${nameText}, () => {\n${children}\n});`;
  }

  function statement(node, context) {
    if (ts.isVariableStatement(node)) {
      if (!(node.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) fail();
      for (const { name, initializer } of node.declarationList.declarations) {
        const value = initializer && expression(initializer, context, context.inLoop);
        const declared = new Map();
        bind(name, context.inLoop ? "data" : value, declared);
        for (const [identifier, type] of declared) {
          if (context.bindings.has(identifier)) fail(identifier);
          context.bindings.set(identifier, type);
          if (context.inLoop) context.projected.add(identifier);
        }
      }
      return context.inLoop ? node.getText(context.source) : "";
    }
    if (ts.isFunctionDeclaration(node)) {
      bind(node.name, "function", context.bindings);
      return "";
    }
    if (!context.suite && ts.isClassDeclaration(node)) {
      if (
        node.heritageClauses?.some(
          (clause) => clause.getText(context.source) !== "extends Error",
        ) ||
        node.members.some((member) => !ts.isConstructorDeclaration(member))
      )
        fail();
      bind(node.name, undefined, context.bindings);
      return "";
    }
    if (context.suite && ts.isForOfStatement(node) && !node.awaitModifier) {
      const bindings = new Map(context.bindings);
      const nested = { ...context, bindings, projected: new Set(context.projected), inLoop: true };
      if (
        !ts.isVariableDeclarationList(node.initializer) ||
        !(node.initializer.flags & ts.NodeFlags.Const) ||
        node.initializer.declarations.length !== 1 ||
        expression(node.expression, context, true) !== "array"
      )
        fail();
      const binding = node.initializer.declarations[0].name;
      const loopBindings = new Map();
      bind(binding, undefined, loopBindings);
      for (const key of loopBindings.keys()) {
        bindings.set(key, "data");
        nested.projected.add(key);
      }
      const statements = ts.isBlock(node.statement) ? node.statement.statements : [node.statement];
      const children = statements.map((child) => statement(child, nested)).join("\n");
      return `for (const ${binding.getText(context.source)} of ${node.expression.getText(context.source)}) {\n${children}\n}`;
    }
    if (ts.isExpressionStatement(node)) {
      const value = node.expression;
      if (ts.isStringLiteral(value)) return "";
      if (
        !context.suite &&
        ts.isBinaryExpression(value) &&
        value.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const target = value.left.getText(context.source);
        if (target === "module.exports") {
          context.exports = expression(value.right, context);
          return "";
        }
        if (
          target === "isolatedGitExecFile[promisify.custom]" &&
          context.bindings.get("isolatedGitExecFile") === "function" &&
          context.bindings.get("promisify") === "promisify" &&
          functionValue(value.right)
        )
          return "";
      }
      if (
        !context.suite &&
        ts.isCallExpression(value) &&
        value.expression.getText(context.source) === "process.once" &&
        value.arguments.length === 2 &&
        value.arguments[0].getText(context.source) === '"exit"' &&
        functionValue(value.arguments[1]) &&
        !context.bindings.has("process")
      )
        return "";
      if (context.suite) return registration(value, context);
    }
    return fail();
  }

  function scan(file, suite) {
    const source = syntax(file);
    const bindings = new Map([
      ["__dirname", "string"],
      ["__filename", "string"],
      ["undefined", "data"],
    ]);
    const context = { file, source, suite, bindings, projected: new Set(), exports: undefined };
    const projection = source.statements.map((node) => statement(node, context)).join("\n");
    return { projection, exports: context.exports };
  }

  const registrations = [];
  const seen = new Set();
  const groups = [];
  for (const file of files) {
    const start = registrations.length;
    function register(name, group) {
      if (typeof name !== "string" || !name) fail();
      const key = JSON.stringify([...groups, name]);
      if (seen.has(key)) fail();
      seen.add(key);
      registrations.push({ name, file, ancestors: [...groups], group });
    }
    const { projection } = scan(file, true);
    runInNewContext(
      projection,
      {
        record: (name) => register(name, false),
        group(name, children) {
          register(name, true);
          groups.push(name);
          children();
          groups.pop();
        },
      },
      { filename: file, timeout: 250 },
    );
    if (registrations.length === start) fail();
  }
  return registrations;
}
