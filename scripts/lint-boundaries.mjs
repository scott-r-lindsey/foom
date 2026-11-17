import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import areaSnapshot from "./area-boundaries-baseline.json" with { type: "json" };
import configuredAreas from "./area-boundaries.json" with { type: "json" };
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
 * @type {Parameters<import("oxlint/plugins-dev").RuleTester["run"]>[1]}
 */
export const processBoundaries = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      boundary: "{{from}} cannot import {{to}} code; use shared contracts and IPC.",
      browser: "{{from}} must stay browser-safe; {{module}} is a platform capability.",
      preload:
        "Sandboxed preload runtime imports are limited to electron and the bundled board-commands registry; use type-only shared contracts.",
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
        !(to === "node-common" && (from === "main" || from === "cli")) &&
        !(
          from === "terminal-host" &&
          local &&
          [
            "vendor-install",
            "repository-setup-sources",
            "repository-setup-check",
            "repository-setup-digest",
            "repository-setup-run",
            "repository-setup-admission",
          ].some(
            (helper) =>
              resolve(dirname(filename), name) === resolve(sourceRoot, `node-common/${helper}`),
          )
        )
      ) {
        context.report({ node, messageId: "boundary", data: { from, to } });
        return;
      }
      if (
        from === "preload" &&
        !typeOnly &&
        name !== "electron" &&
        !(
          local && resolve(dirname(filename), name) === resolve(sourceRoot, "shared/board-commands")
        )
      ) {
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

/** @typedef {{publicModules: string[], imports: Record<string, "type" | "value">}} Area */
/** @typedef {Record<string, Record<string, Area>>} AreaPolicy */
/** @type {AreaPolicy} */
export const areaPolicy = configuredAreas;
// Historical ceiling, not a regeneratable allowlist. Shrink area-boundaries.json
// as dependencies disappear. Amending this snapshot requires an explicit policy PR.
const snapshotDigest = "bba6c572c5adb82352bc5ff5a43d510877f8bd5cec057fa9f32a267868a49f16";

/** @param {AreaPolicy} policy */
export function validateAreaPolicy(policy) {
  const errors = [];
  if (createHash("sha256").update(JSON.stringify(areaSnapshot)).digest("hex") !== snapshotDigest)
    errors.push("historical snapshot changed; an explicit boundary-policy amendment is required");
  for (const process of Object.keys(policy)) {
    if (!Object.hasOwn(areaSnapshot.areas, process)) {
      errors.push(`undeclared process ${process}`);
      continue;
    }
    const snapshot = areaSnapshot.areas[process];
    for (const [name, area] of Object.entries(policy[process])) {
      if (!Object.hasOwn(snapshot, name)) {
        errors.push(`new area ${process}/${name}`);
        continue;
      }
      const original = snapshot[name];
      for (const module of area.publicModules) {
        if (!original.publicModules.includes(module))
          errors.push(`new public module ${process}/${name}/${module}`);
      }
      for (const [to, kind] of Object.entries(area.imports)) {
        const prior = original.imports[to];
        if (
          !Object.hasOwn(original.imports, to) ||
          (prior === "type" && kind !== "type") ||
          !["type", "value"].includes(kind)
        )
          errors.push(`new or widened edge ${process}/${name} -> ${process}/${to}`);
        if (!Object.hasOwn(policy[process], to))
          errors.push(`edge targets undeclared area ${process}/${to}`);
      }
    }
  }
  return errors;
}
const policyErrors = validateAreaPolicy(areaPolicy);

function areaOwner(filename) {
  const [process, area, ...rest] = relative(sourceRoot, filename).split(sep);
  if (process !== "main" && process !== "renderer") return undefined;
  return { process, area: rest.length ? area : "(root)" };
}

function moduleFile(target) {
  // Mirror TS's local .js substitution and declaration lookup without merging a
  // sibling runtime module with its distinct foo.d.ts contract.
  const stem = target.replace(/\.[cm]?jsx?$/, "");
  return (
    [
      `${stem}.ts`,
      `${stem}.tsx`,
      `${stem}.d.ts`,
      target,
      resolve(target, "index.ts"),
      resolve(target, "index.tsx"),
    ].find((file) => existsSync(file) && statSync(file).isFile()) ?? target
  );
}

/** @type {Parameters<import("oxlint/plugins-dev").RuleTester["run"]>[1]} */
export const areaBoundaries = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      edge: "{{from}} cannot import {{to}} in {{file}}; the edge is outside the frozen area policy.",
      entry:
        "{{from}} cannot deep-import {{to}} in {{file}}; target one of its declared public modules.",
      types: "{{from}} may import only types from {{to}} in {{file}}.",
      wiring: "{{from}} cannot import composition root {{to}} in {{file}}.",
      unknown: "{{from}} uses undeclared area {{to}} in {{file}}.",
      policy: "Invalid area policy: {{reason}}.",
    },
  },
  create(context) {
    const filename = context.filename;
    const from = areaOwner(filename);
    if (!from) return {};
    const areas = areaPolicy[from.process];
    if (policyErrors.length)
      return {
        Program(node) {
          context.report({ node, messageId: "policy", data: { reason: policyErrors.join("; ") } });
        },
      };
    if (!Object.hasOwn(areas, from.area))
      return {
        Program(node) {
          context.report({
            node,
            messageId: "unknown",
            data: {
              from: `${from.process}/${from.area}`,
              to: `${from.process}/${from.area}`,
              file: relative(sourceRoot, filename),
            },
          });
        },
      };
    function check(node, source, typeOnly = false) {
      if (typeof source?.value !== "string") return;
      const name = source.value;
      if (!name.startsWith(".") && !isAbsolute(name)) return;
      const target = moduleFile(resolve(dirname(filename), name));
      const to = areaOwner(target);
      if (!to || to.process !== from.process || to.area === "(root)" || from.area === to.area)
        return;
      const data = {
        from: `${from.process}/${from.area}`,
        to: `${to.process}/${to.area}`,
        file: relative(sourceRoot, target).split(sep).join("/"),
      };
      if (!Object.hasOwn(areas, to.area)) {
        context.report({ node, messageId: "unknown", data });
        return;
      }
      if (to.area === "wiring" && filename !== resolve(sourceRoot, "main/main.ts")) {
        context.report({ node, messageId: "wiring", data });
        return;
      }
      const edge = areas[from.area].imports[to.area];
      if (!Object.hasOwn(areas[from.area].imports, to.area)) {
        context.report({ node, messageId: "edge", data });
        return;
      }
      if (
        !areas[to.area].publicModules.some(
          (module) => target === resolve(sourceRoot, from.process, to.area, module),
        )
      ) {
        context.report({ node, messageId: "entry", data });
        return;
      }
      if (edge === "type" && !typeOnly) context.report({ node, messageId: "types", data });
    }
    return {
      ImportDeclaration(node) {
        check(
          node,
          node.source,
          node.importKind === "type" ||
            (node.specifiers.length > 0 && node.specifiers.every((s) => s.importKind === "type")),
        );
      },
      ExportNamedDeclaration(node) {
        check(
          node,
          node.source,
          node.exportKind === "type" ||
            (node.specifiers.length > 0 && node.specifiers.every((s) => s.exportKind === "type")),
        );
      },
      ExportAllDeclaration(node) {
        check(node, node.source, node.exportKind === "type");
      },
      ImportExpression(node) {
        check(node, node.source);
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require")
          check(node, node.arguments[0]);
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type === "TSExternalModuleReference")
          check(node, node.moduleReference.expression, node.importKind === "type");
      },
      TSImportType(node) {
        check(node, node.source, true);
      },
    };
  },
};

export default {
  rules: { "process-boundaries": processBoundaries, "area-boundaries": areaBoundaries },
};
