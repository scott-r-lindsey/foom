import { readFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { runInNewContext } from "node:vm";
import { hashBucket, parseShard, shardAssignments } from "../tests/electron/shard-assignment.js";

// Inventory for the shard planner. This can collect generated cases, but
// running outside a worker cannot prove that the inventory is complete.
export function discoverRegistrations(files) {
  const registrations = new Map();
  for (const file of files) {
    const suiteRequire = createRequire(file);
    const size = registrations.size;
    const source = readFileSync(file, "utf8");
    function requireForDiscovery(specifier) {
      if (specifier === "./test-shard.js") {
        return {
          test(name) {
            if (typeof name !== "string" || !name || registrations.has(name))
              throw new Error(`Missing or duplicate Electron test name in ${file}`);
            registrations.set(name, file);
          },
        };
      }
      if (specifier === "node:test") return { afterEach() {} };
      if (/^(?:node:)?(?:module|process)$/.test(specifier))
        throw new Error("Worker-dependent Electron registration");
      return suiteRequire(specifier);
    }
    runInNewContext(
      source,
      {
        // Test options use the host platform. Names that depend on worker
        // state, argv or the environment cannot be resolved in the wrapper.
        process: new Proxy(
          {
            platform: process.platform,
            arch: process.arch,
            getBuiltinModule: (specifier) =>
              isBuiltin(specifier) ? requireForDiscovery(specifier) : undefined,
          },
          {
            get(target, key) {
              if (!Object.hasOwn(target, key))
                throw new Error("Worker-dependent Electron registration");
              return target[key];
            },
          },
        ),
        require: requireForDiscovery,
      },
      { filename: file },
    );
    if (registrations.size === size) throw new Error(`No Electron registrations in ${file}`);
  }
  return registrations;
}

function discoverStaticRegistrations(files) {
  const ts = createRequire(import.meta.url)("typescript");
  const registrations = new Map();
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.JS,
    );
    const [binding, ...statements] = source.statements;
    if (
      source.parseDiagnostics.length > 0 ||
      !binding ||
      !ts.isVariableStatement(binding) ||
      !(binding.declarationList.flags & ts.NodeFlags.Const) ||
      binding.declarationList.declarations.length !== 1
    )
      return undefined;
    const [{ name, initializer }] = binding.declarationList.declarations;
    if (
      !ts.isObjectBindingPattern(name) ||
      name.elements.length !== 1 ||
      name.elements[0].getText(source) !== "test" ||
      !initializer ||
      !ts.isCallExpression(initializer) ||
      initializer.expression.getText(source) !== "require" ||
      initializer.arguments.length !== 1 ||
      !ts.isStringLiteral(initializer.arguments[0]) ||
      initializer.arguments[0].text !== "./test-shard.js" ||
      statements.length === 0
    )
      return undefined;

    // Only straight-line registrations through the shard helper are proven.
    // Executable setup, imported helpers, and describe callbacks can add tests
    // or change their ancestry in the worker. Leave those suites to Node.
    for (const statement of statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
        return undefined;
      const { expression, arguments: args, questionDotToken } = statement.expression;
      if (!ts.isIdentifier(expression) || expression.text !== "test" || questionDotToken)
        return undefined;
      const [name, body] = args;
      if (
        args.length !== 2 ||
        !ts.isStringLiteral(name) ||
        !name.text ||
        registrations.has(name.text) ||
        (!ts.isArrowFunction(body) && !ts.isFunctionExpression(body))
      )
        return undefined;
      registrations.set(name.text, file);
    }
  }
  return registrations;
}

export function selectSuiteFiles(files, { shard, patterns }) {
  if (shard === undefined && patterns.length === 0) return files;
  try {
    const { count, index } = parseShard(shard);
    if (count === 1 && patterns.length === 0) return files;
    const assignments = shardAssignments(count);
    if (count > 1 && assignments.size === 0) return files;
    // Node accepts both plain and /pattern/flags syntax. Stateful matching
    // depends on registration order, so let Node handle those filters alone.
    const matchers = patterns.map((pattern) => {
      const literal = /^\/(.*)\/([a-z]*)$/.exec(pattern);
      return new RegExp(literal?.[1] ?? pattern, literal?.[2]);
    });
    if (
      matchers.some(
        (matcher) => matcher.global || matcher.sticky || matcher.test("<root>") || matcher.test(""),
      )
    )
      return files;

    const registrations = discoverStaticRegistrations(files);
    if (!registrations) return files;
    if (count > 1 && [...assignments.keys()].some((name) => !registrations.has(name))) return files;
    const selected = new Set();
    for (const [name, file] of registrations) {
      if (count > 1) {
        const bucket = assignments.get(name);
        if (bucket === undefined) {
          if (hashBucket(name, count) === index) return files;
          continue;
        }
        if (bucket !== index) continue;
      }
      if (
        matchers.length === 0 ||
        matchers.some((matcher) => matcher.test(name) || matcher.test(name.trim()))
      )
        selected.add(file);
    }
    return selected.size === 0 ? files : files.filter((file) => selected.has(file));
  } catch {
    // Preserve the actual worker's behavior and diagnostics if discovery fails.
    return files;
  }
}
