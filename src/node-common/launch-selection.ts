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
  let result = [...defaults];
  for (const field of ["model", "effort"] as const) {
    const value = selection[field];
    const spec = manifest.launch[field];
    if (value === undefined || !spec) continue;
    const template = spec.arguments.slice(1).join("");
    const key = template === "{value}" ? undefined : template.slice(0, template.indexOf("="));
    const kept: string[] = [];
    for (let i = 0; i < result.length; i++) {
      const arg = result[i] ?? "";
      const flag = spec.flags.find(
        (name) =>
          arg === name || arg.startsWith(`${name}=`) || (name.length === 2 && arg.startsWith(name)),
      );
      const separate = flag === arg;
      const content = separate ? result[i + 1] : arg.slice(flag?.length).replace(/^=/u, "");
      // Normalize quoted config keys just as the existing config matcher does.
      const matches =
        flag !== undefined &&
        (key === undefined ||
          (content?.includes("=") &&
            content
              .slice(0, content.indexOf("="))
              .trim()
              .replace(/^(["'])(.*)\1$/u, "$2") === key));
      if (matches) {
        if (separate && content !== undefined && !content.startsWith("-")) i++;
      } else kept.push(arg);
    }
    result = [...kept, ...spec.arguments.map((arg) => arg.replaceAll("{value}", value))];
  }
  return result;
}
