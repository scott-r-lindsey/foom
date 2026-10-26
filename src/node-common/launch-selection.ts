import type { LaunchSelection } from "../shared/agents";
import type { AgentManifestV2 } from "../shared/agent-manifest-v2";
import { ControlError } from "./control-validation";

/** Transport input is data, never argv, a shell fragment or a config expression. */
export function selectionInput(data: Record<string, unknown>): LaunchSelection {
  const result: LaunchSelection = {};
  for (const field of ["model", "effort"] as const) {
    const value = data[field];
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      value.trim() !== value ||
      !/^[A-Za-z0-9._:/][A-Za-z0-9._:/-]{0,63}$/u.test(value)
    )
      throw new ControlError("invalid_request");
    result[field] = value;
  }
  return result;
}

export function validateSelection(manifest: AgentManifestV2, selection: LaunchSelection): void {
  selectionInput({ ...selection });
  for (const field of ["model", "effort"] as const) {
    const value = selection[field];
    if (value === undefined) continue;
    const spec = manifest.launch[field];
    if (!spec) throw new ControlError("unsupported");
    if (spec.values && !spec.values.includes(value)) throw new ControlError("invalid_request");
  }
}

/** Replace only declared selectors; config templates match their exact literal key. */
export function selectedArguments(
  manifest: AgentManifestV2,
  defaults: readonly string[],
  selection: LaunchSelection = {},
): string[] {
  validateSelection(manifest, selection);
  const requested = (["model", "effort"] as const).flatMap((field) => {
    const value = selection[field];
    const spec = manifest.launch[field];
    if (value === undefined || !spec) return [];
    const template = spec.arguments.slice(1).join("");
    const key = template === "{value}" ? undefined : template.slice(0, template.indexOf("="));
    return [{ spec, value, key }];
  });
  if (requested.length === 0) return [...defaults];
  const valueFlags = new Set([
    ...(manifest.launch.valueFlags ?? []),
    ...(manifest.launch.model?.flags ?? []),
    ...(manifest.launch.effort?.flags ?? []),
  ]);
  const kept: string[] = [];
  let consumed = false;
  // Scan the original argv once: a literal value never becomes an option on a later pass.
  for (const [index, arg] of defaults.entries()) {
    if (consumed) {
      consumed = false;
      continue;
    }
    const next = valueFlags.has(arg) ? defaults[index + 1] : undefined;
    const replaced = requested.some(({ spec, key }) => {
      const flag = spec.flags.find(
        (name) =>
          arg === name || arg.startsWith(`${name}=`) || (name.length === 2 && arg.startsWith(name)),
      );
      const content = flag === arg ? next : arg.slice(flag?.length).replace(/^=/u, "");
      // Normalize quoted config keys just as the existing config matcher does.
      return (
        flag !== undefined &&
        (key === undefined ||
          (content?.includes("=") &&
            content
              .slice(0, content.indexOf("="))
              .trim()
              .replace(/^(["'])(.*)\1$/u, "$2") === key))
      );
    });
    if (!replaced) kept.push(arg);
    if (next !== undefined) {
      consumed = true;
      // Retain option-looking values of removed selectors for the final bypass inspection.
      if (!replaced || next.startsWith("-")) kept.push(next);
    }
  }
  return [
    ...kept,
    ...requested.flatMap(({ spec, value }) =>
      spec.arguments.map((arg) => arg.replaceAll("{value}", value)),
    ),
  ];
}
