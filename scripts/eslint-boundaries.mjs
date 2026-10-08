import { builtinModules } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const processes = new Set([
  "main",
  "terminal-host",
  "preload",
  "renderer",
  "shared",
  "cli",
  "node-common",
]);
const nodeModules = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

function owner(filename) {
  const directory = relative(sourceRoot, filename).split(sep)[0];
  return processes.has(directory) ? directory : undefined;
}

/**
 * Keep process dependencies explicit, including imports through shared helpers.
 * @type {import("eslint").Rule.RuleModule}
 */
export const processBoundaries = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      boundary: "{{from}} cannot import {{to}} code; use shared contracts and IPC.",
      browser: "{{from}} must stay browser-safe; {{module}} is a platform capability.",
      preload:
        "Sandboxed preload runtime imports are limited to electron; use type-only shared contracts.",
    },
  },
  create(context) {
    const filename = context.filename;
    const from = owner(filename);
    if (!from) return {};
    function check(node, source, typeOnly = false) {
      if (typeof source?.value !== "string") return;
      const name = source.value;
      const local = name.startsWith(".") || isAbsolute(name);
      const to = local ? owner(resolve(dirname(filename), name)) : undefined;
      if (
        to &&
        to !== from &&
        to !== "shared" &&
        !(to === "node-common" && (from === "main" || from === "cli"))
      ) {
        context.report({ node, messageId: "boundary", data: { from, to } });
        return;
      }
      if (from === "preload" && !typeOnly && name !== "electron") {
        context.report({ node, messageId: "preload" });
        return;
      }
      if (
        (from === "cli" || from === "node-common") &&
        /^(electron|node-pty|@xterm\/headless)(\/|$)/.test(name)
      ) {
        context.report({ node, messageId: "browser", data: { from, module: name } });
      }
      if (
        (from === "renderer" || from === "shared") &&
        (name.startsWith("node:") ||
          nodeModules.has(name) ||
          /^(electron|node-pty|@xterm\/headless)(\/|$)/.test(name))
      ) {
        context.report({ node, messageId: "browser", data: { from, module: name } });
      }
    }
    return {
      ImportDeclaration(node) {
        const typeOnly =
          node.importKind === "type" ||
          (node.specifiers.length > 0 &&
            node.specifiers.every((specifier) => specifier.importKind === "type"));
        check(node, node.source, typeOnly);
      },
      ExportNamedDeclaration(node) {
        const typeOnly =
          node.exportKind === "type" ||
          (node.specifiers.length > 0 &&
            node.specifiers.every((specifier) => specifier.exportKind === "type"));
        check(node, node.source, typeOnly);
      },
      ExportAllDeclaration(node) {
        check(node, node.source, node.exportKind === "type");
      },
      ImportExpression(node) {
        check(node, node.source);
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require") {
          check(node, node.arguments[0]);
        }
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type === "TSExternalModuleReference") {
          check(node, node.moduleReference.expression, node.importKind === "type");
        }
      },
    };
  },
};
