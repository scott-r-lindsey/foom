import type { AgentManifestV2, ManifestCondition, ManifestFile } from "./agent-manifest-v2";
import { fail, isRecord } from "./agent-manifest-values";
import { dataContainer, validateCommandSlots } from "./agent-manifest-container";

function identity(value: unknown): string {
  return JSON.stringify(value);
}
export function implies(
  selected: ManifestCondition | undefined,
  required: ManifestCondition | undefined,
): boolean {
  if (!required) return true;
  const all = (selected?.all ?? []).map(identity);
  const requiredAll = required.all ?? [];
  if (!requiredAll.every((test) => all.includes(identity(test)))) return false;
  if (required.any === undefined) return true;
  const any = required.any.map(identity);
  return (
    all.some((test) => any.includes(test)) ||
    (selected?.any !== undefined && selected.any.every((test) => any.includes(identity(test))))
  );
}
/** Validate references and native serialization positions without preparing a launch. */
export function validateTemplates(manifest: AgentManifestV2): void {
  const channels = manifest.hooks?.channels ?? [];
  const commands = new Set<string>();
  const argvs = new Set<string>();
  let bytes = 0;
  const expand = (
    source: string,
    location: string,
    path: string,
    selected?: ManifestCondition,
    file?: ManifestFile,
  ): string => {
    // Validation stand-ins are never authorable, including JSON/TOML escape spellings.
    const decoded = source
      .replace(
        /\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8}))/gu,
        (match: string, short: string | undefined, long: string | undefined) => {
          const point = Number.parseInt(short ?? long ?? "", 16);
          return point <= 0x10ffff ? String.fromCodePoint(point) : match;
        },
      )
      .replace(/\\[ \t]*\n[ \t\n]*/gu, "");
    if (
      [
        "FOOM_OBSERVER_",
        "FOOM_MCP_URL_SENTINEL",
        "FOOM_MCP_NAME_SENTINEL",
        "FOOM_AUTHORIZATION_SENTINEL",
      ].some((marker) => decoded.includes(marker))
    )
      fail(path, "invalid-template");
    let result = source;
    const numericObservers = new Set<string>();
    const mcpFile =
      file?.scope === "launch" &&
      manifest.launch.mcp?.arguments.some((arg) => arg.includes(`{file:${file.name}}`));
    if (
      (source.includes("{mcpName") ||
        source.includes("{mcpUrl") ||
        source.includes("${FOOM_CONTROL_TOKEN}")) &&
      location === "file" &&
      (!mcpFile || !implies(file.when, manifest.launch.mcp?.when))
    )
      fail(path, "incompatible-combination");
    const environment = "${FOOM_CONTROL_TOKEN}";
    if (result.includes(environment)) {
      if (location !== "file" || file?.format !== "json") fail(path, "environment-reference");
      result = result.replaceAll(environment, "FOOM_AUTHORIZATION_SENTINEL");
    }
    if (/\$\{|\$[A-Za-z_]|%[A-Za-z_][A-Za-z0-9_]*%/u.test(result))
      fail(path, "environment-reference");
    result = result.replace(
      /\{([A-Za-z][A-Za-z0-9]*)(?::([^{}\n]*))?\}/gu,
      (_match: string, name: string, detail: string | undefined) => {
        const parts = detail?.split(":") ?? [];
        if (["prompt", "conversationId", "newId", "hookDir", "pluginDir", "tool"].includes(name)) {
          const allowed =
            name === "prompt"
              ? "prompt"
              : name === "conversationId"
                ? "resume"
                : name === "newId"
                  ? "newId"
                  : name === "hookDir"
                    ? "channel"
                    : name === "pluginDir"
                      ? "setup"
                      : "tools";
          if (location !== allowed || detail !== undefined) fail(path, "unknown-placeholder");
          return "FOOM_VALUE";
        }
        if (name === "hookFile" || name === "file") {
          if (parts.length !== 1 || location !== (name === "file" ? "mcp" : "channel"))
            fail(path, "unknown-placeholder");
          const target = manifest.files.find((entry) => entry.name === parts[0]);
          if (!target || target.scope !== "launch") fail(path, "dangling-reference");
          if (!implies(selected, target.when)) fail(path, "unselected-attachment");
          return "FOOM_FILE";
        }
        if (name === "mcpName" || name === "mcpUrl") {
          if (location !== "mcp" && location !== "file") fail(path, "unknown-placeholder");
          if (location === "file" && (!file || parts[0] !== file.format || parts.length !== 1))
            fail(path, "unknown-placeholder");
          if (
            parts.length > 1 ||
            (parts.length === 1 && parts[0] !== "json" && parts[0] !== "toml")
          )
            fail(path, "unknown-placeholder");
          const marker = name === "mcpUrl" ? "FOOM_MCP_URL_SENTINEL" : "FOOM_MCP_NAME_SENTINEL";
          return detail ? JSON.stringify(marker) : marker;
        }
        if (["observerCommand", "observerArgv", "observerVersion"].includes(name)) {
          if (location !== "channel" && location !== "file") fail(path, "unknown-placeholder");
          const [channelId, event] = (parts[0] ?? "").split(".");
          const channel = channels.find((entry) => entry.id === channelId);
          if (
            !channel ||
            (event !== undefined &&
              (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(event) ||
                !channel.mapping.cases.some((entry) => entry.event === event)))
          )
            fail(path, "dangling-reference");
          if ((parts[0]?.split(".").length ?? 0) > 2) fail(path, "unknown-placeholder");
          if (file?.scope !== "plugin" && !implies(selected, channel.when))
            fail(path, "unselected-attachment");
          if (name === "observerCommand" && channel.observer.transport !== "stdin")
            fail(path, "incompatible-combination");
          if (name === "observerArgv" && channel.observer.transport !== "argv-last")
            fail(path, "incompatible-combination");
          if (name === "observerVersion") {
            if (
              location !== "file" ||
              file?.scope !== "plugin" ||
              file.format !== "json" ||
              parts.length !== 1 ||
              event !== undefined ||
              channel.observer.placement !== "plugin"
            )
              fail(path, "unknown-placeholder");
            numericObservers.add("-987654321");
            return "-987654321";
          }
          if (
            parts.length !== 2 ||
            (parts[1] !== "json" && parts[1] !== "toml") ||
            (name === "observerArgv" && parts[1] !== "json") ||
            (file && parts[1] !== file.format)
          )
            fail(path, "unknown-placeholder");
          if (file?.scope === "plugin" && channel.observer.placement !== "plugin")
            fail(path, "incompatible-combination");
          const marker = `FOOM_OBSERVER_${String(commands.size + argvs.size)}_SENTINEL`;
          if (name === "observerCommand") {
            commands.add(marker);
            return JSON.stringify(marker);
          }
          argvs.add(marker);
          return JSON.stringify([marker]);
        }
        fail(path, "unknown-placeholder");
      },
    );
    if (/\{[A-Za-z][A-Za-z0-9]*(?::|\}|$)/u.test(result)) fail(path, "unknown-placeholder");
    if (numericObservers.size && file) {
      const checkNumeric = (value: unknown): void => {
        if (typeof value === "string" && value.includes("-987654321"))
          fail(path, "invalid-template");
        if (Array.isArray(value)) for (const entry of value) checkNumeric(entry);
        else if (typeof value === "object" && value !== null)
          for (const [key, entry] of Object.entries(value)) {
            checkNumeric(key);
            checkNumeric(entry);
          }
      };
      checkNumeric(dataContainer(result, file.format, path));
    }
    if (
      /\{(?:prompt|conversationId|newId|hookDir|pluginDir|tool|hookFile|file|observerCommand|observerArgv|observerVersion|mcpName|mcpUrl)\b/u.test(
        result,
      )
    )
      fail(path, "unknown-placeholder");
    return result;
  };
  const check = (
    args: readonly string[],
    location: string,
    path: string,
    selected?: ManifestCondition,
  ) => {
    for (const [index, arg] of args.entries()) {
      const expanded = expand(arg, location, `${path}[${String(index)}]`, selected);
      const assignment = /^[-A-Za-z0-9_.]+\s*=/u.test(expanded);
      const key = assignment ? expanded.slice(0, expanded.indexOf("=")).trim() : undefined;
      const value = assignment ? expanded.slice(expanded.indexOf("=") + 1) : expanded;
      if (
        (location === "channel" || location === "mcp") &&
        (/^[[{]/u.test(value.trimStart()) ||
          expanded.includes("FOOM_OBSERVER_") ||
          (location === "mcp" &&
            expanded.includes("FOOM_MCP_URL_SENTINEL") &&
            key !== undefined &&
            !key.startsWith("-")))
      ) {
        if (
          key?.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part))
        )
          fail(path, "unsafe-key");
        let container: unknown;
        try {
          container = dataContainer(value, "json", path);
        } catch {
          container = dataContainer(value, "toml", path);
        }
        validateCommandSlots(
          key === undefined ? container : { [key]: container },
          commands,
          argvs,
          path,
        );
      }
    }
  };
  for (const stage of ["arguments", "display", "resume", "mcp"] as const) {
    const block = manifest.launch[stage];
    if (block) check(block.arguments, stage, `$.launch.${stage}`, block.when);
  }
  if (manifest.launch.prompt) {
    const args = manifest.launch.prompt.arguments;
    if (
      args.filter((arg) => arg === "{prompt}").length !== 1 ||
      args.some((arg) => arg.includes("{prompt}") && arg !== "{prompt}")
    )
      fail("$.launch.prompt", "missing-placeholder");
    if (
      args.includes("--") &&
      (args.at(-1) !== "{prompt}" || manifest.launch.order.at(-1) !== "prompt")
    )
      fail("$.launch.prompt", "incompatible-combination");
    check(args, "prompt", "$.launch.prompt.arguments");
  }
  if (manifest.launch.resume && !manifest.launch.resume.arguments.includes("{conversationId}"))
    fail("$.launch.resume", "missing-placeholder");
  if (manifest.conversation.newId) {
    if (!manifest.conversation.newId.arguments.includes("{newId}"))
      fail("$.conversation.newId", "missing-placeholder");
    check(manifest.conversation.newId.arguments, "newId", "$.conversation.newId.arguments");
  }
  if (manifest.launch.toolPermissions) {
    if (!manifest.launch.mcp || !manifest.launch.toolPermissions.arguments.includes("{tool}"))
      fail("$.launch.toolPermissions", "incompatible-combination");
    check(manifest.launch.toolPermissions.arguments, "tools", "$.launch.toolPermissions.arguments");
  }
  for (const [index, channel] of channels.entries())
    check(
      channel.arguments,
      "channel",
      `$.hooks.channels[${String(index)}].arguments`,
      channel.when,
    );
  if (
    manifest.setup?.actions.some((action) => action.arguments?.[1] === "install") &&
    !manifest.files.some(
      (file) => file.scope === "plugin" && file.format === "json" && file.name === "plugin.json",
    )
  )
    fail("$.setup.actions", "incompatible-combination");
  for (const [index, file] of manifest.files.entries()) {
    const path = `$.files[${String(index)}].content`;
    bytes += new TextEncoder().encode(file.content).length;
    if (bytes > 32768) fail("$.files", "too-large");
    const expanded = expand(file.content, "file", path, file.when, file);
    const container = dataContainer(expanded, file.format, path, true);
    if (
      file.scope === "plugin" &&
      file.name === "plugin.json" &&
      manifest.setup?.status.ownership
    ) {
      const target = manifest.setup.status.ownership.directory.split("/").at(-1);
      if (!isRecord(container) || container["name"] !== target)
        fail(path, "incompatible-combination");
    }
    validateCommandSlots(container, commands, argvs, path);
    const checkAuth = (value: unknown, key?: string) => {
      if (
        typeof value === "string" &&
        value.includes("FOOM_AUTHORIZATION_SENTINEL") &&
        (key !== "Authorization" || value !== "Bearer FOOM_AUTHORIZATION_SENTINEL")
      )
        fail(path, "environment-reference");
      if (Array.isArray(value)) for (const item of value) checkAuth(item);
      else if (typeof value === "object" && value !== null)
        for (const [key, item] of Object.entries(value)) {
          if (key.includes("FOOM_AUTHORIZATION_SENTINEL")) fail(path, "environment-reference");
          checkAuth(item, key);
        }
    };
    checkAuth(container);
  }
  for (const [index, action] of (manifest.setup?.actions ?? []).entries()) {
    if (action.arguments)
      check(action.arguments, "setup", `$.setup.actions[${String(index)}].arguments`);
    if (Array.isArray(action.statusProbe))
      check(action.statusProbe, "fixed", `$.setup.actions[${String(index)}].statusProbe`);
  }
  if (manifest.setup?.status.probe)
    check(manifest.setup.status.probe.arguments, "fixed", "$.setup.status.probe.arguments");
}
