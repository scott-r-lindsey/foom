import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
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
          ["vendor-install"].some(
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
const snapshotDigest = "943f2c742a4525a1ea9a0427444ddc52a2d3e7e49985a07ea1b5fe4230ade891";

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
  const variant = target.endsWith(".mjs") ? "mts" : target.endsWith(".cjs") ? "cts" : "ts";
  return (
    [
      `${stem}.${variant}`,
      `${stem}.tsx`,
      `${stem}.d.${variant}`,
      `${stem}.mts`,
      `${stem}.cts`,
      target,
      resolve(target, "index.ts"),
      resolve(target, "index.tsx"),
      resolve(target, "index.mts"),
      resolve(target, "index.cts"),
      resolve(target, "index.js"),
      resolve(target, "index.mjs"),
      resolve(target, "index.cjs"),
    ].find((file) => existsSync(file) && statSync(file).isFile()) ?? target
  );
}

// Inspect every conditional target: an alias must preserve the policy in every
// supported environment, rather than depending on the linter's Node conditions.
function packageTargets(filename, name) {
  let directory = dirname(filename);
  while (!existsSync(resolve(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  try {
    const imports = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")).imports;
    if (!imports || typeof imports !== "object") return undefined;
    let target = Object.hasOwn(imports, name) ? imports[name] : undefined;
    let capture;
    if (target === undefined) {
      const pattern = Object.keys(imports)
        .filter((key) => {
          const parts = key.split("*");
          if (parts.length !== 2) return false;
          const [prefix, suffix] = parts;
          return name.length >= key.length && name.startsWith(prefix) && name.endsWith(suffix);
        })
        .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length)[0];
      if (pattern) {
        const [prefix, suffix] = pattern.split("*");
        capture = name.slice(prefix.length, name.length - suffix.length);
        target = imports[pattern];
      }
    }
    function collect(value) {
      if (typeof value === "string") {
        const mapped = capture === undefined ? value : value.replaceAll("*", capture);
        if (!mapped.startsWith("./")) return undefined;
        const path = resolve(directory, mapped);
        if (relative(directory, path).startsWith("..")) return undefined;
        const file = moduleFile(path);
        if (!existsSync(file) || !statSync(file).isFile()) return undefined;
        return [file];
      }
      if (!value || typeof value !== "object") return undefined;
      const branches = Object.values(value).map(collect);
      if (!branches.length || branches.some((branch) => !branch)) return undefined;
      return branches.flat();
    }
    return collect(target);
  } catch {
    return undefined;
  }
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
      unresolved:
        "Area imports must use resolvable literal specifiers; cannot resolve {{specifier}}.",
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
      // A missing source on a local export is not a module dependency.
      if (!source) return;
      const name =
        source.type === "TemplateLiteral" && source.expressions.length === 0
          ? source.quasis[0].value.cooked
          : source.value;
      if (typeof name !== "string") {
        context.report({
          node,
          messageId: "unresolved",
          data: { specifier: "dynamic expression" },
        });
        return;
      }
      let targets;
      if (name.startsWith("#")) {
        targets = packageTargets(filename, name);
        if (!targets) {
          context.report({ node, messageId: "unresolved", data: { specifier: name } });
          return;
        }
      } else if (name.startsWith(".") || isAbsolute(name)) {
        targets = [resolve(dirname(filename), name)];
      } else return;
      for (const target of new Set(targets.map(moduleFile))) checkTarget(node, target, typeOnly);
    }
    function checkTarget(node, target, typeOnly) {
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
