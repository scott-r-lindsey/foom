import type { AgentManifestV2, ManifestCondition, ManifestSelector } from "./agent-manifest-v2";
import { boundedRegex } from "./providers/detection";
import { fail, unique } from "./agent-manifest-values";
import { validateTemplates } from "./agent-manifest-templates";

const ENGINE = [
  "hooksEnabled",
  "control",
  "configGreeting",
  "hasPrompt",
  "resume",
  "healthTrusted",
  "setupState",
];
const STATUS = ["owned", "absent", "disabled", "version"];
export function validateV2(manifest: AgentManifestV2): void {
  const channels = manifest.hooks?.channels ?? [];
  const facts = manifest.discovery.facts;
  const metadata = manifest.setup?.status.metadata ?? [];
  const graph = new Map<string, Set<string>>();
  const edge = (from: string, to: string) => {
    const edges = graph.get(from) ?? new Set<string>();
    edges.add(to);
    graph.set(from, edges);
  };
  const selector = (field: ManifestSelector, path: string, sources: readonly string[]) => {
    if (!sources.includes(field.source)) fail(path, "incompatible-selector");
    if (
      field.path.some(
        (key) => typeof key === "string" && ["__proto__", "prototype", "constructor"].includes(key),
      )
    )
      fail(path, "unsafe-key");
    if (
      field.source === "header" &&
      (field.path.length !== 1 ||
        !["X-Foom-Event", "X-Foom-Sequence"].includes(String(field.path[0])))
    )
      fail(path, "incompatible-selector");
    if (
      field.source === "probe" &&
      (!manifest.setup?.status.probe ||
        field.path.length !== 3 ||
        field.path[0] !== "imports" ||
        typeof field.path[1] !== "number" ||
        field.path[2] !== "name")
    )
      fail(path, "incompatible-selector");
    if (field.source === "metadata" && !metadata.some((entry) => entry.id === field.path[0]))
      fail(path, "dangling-reference");
    if (field.source === "facts" && (field.path.length !== 1 || typeof field.path[0] !== "string"))
      fail(path, "incompatible-selector");
  };
  const reference = (
    name: string,
    path: string,
    owner: string,
    available: readonly string[],
    earlierChannels: readonly string[] = [],
  ) => {
    if (name.startsWith("channelAttached:")) {
      const channel = name.slice("channelAttached:".length);
      if (!earlierChannels.includes(channel)) fail(path, "fact-dependency");
      edge(owner, `channel:${channel}`);
    } else if (available.includes(name)) {
      if (name === "setupState") edge(owner, "setup");
      else if (name === "healthTrusted" && manifest.health) edge(owner, "health");
      else if (facts.some((fact) => fact.id === name)) edge(owner, `fact:${name}`);
    } else fail(path, "dangling-reference");
  };
  const condition = (
    when: ManifestCondition | undefined,
    path: string,
    owner: string,
    available: readonly string[],
    sources: readonly string[] = ["facts"],
    earlierChannels: readonly string[] = [],
  ) => {
    if (!when) return;
    const tests = [...(when.all ?? []), ...(when.any ?? [])];
    if (
      tests.length > 16 ||
      (tests.length === 0 && !(when.all?.length === 0 && when.any === undefined)) ||
      when.any?.length === 0
    )
      fail(path, "invalid-condition");
    for (const test of tests) {
      if (typeof test.field === "string")
        reference(test.field, path, owner, available, earlierChannels);
      else {
        selector(test.field, path, sources);
        if (test.field.source === "facts")
          reference(String(test.field.path[0]), path, owner, available, earlierChannels);
      }
      if (test.op === "exists" || test.op === "absent") {
        if (test.value !== undefined) fail(path, "invalid-test");
      } else {
        if (
          test.value === undefined ||
          (test.op === "in" ? !Array.isArray(test.value) : Array.isArray(test.value))
        )
          fail(path, "invalid-test");
        if (
          (test.op === "lt" || test.op === "gte") &&
          (typeof test.value !== "number" || !Number.isSafeInteger(test.value))
        )
          fail(path, "invalid-test");
      }
    }
  };
  const requirements = (
    require: (typeof channels)[number]["mapping"]["cases"][number]["require"],
    path: string,
    sources: readonly string[],
  ) => {
    unique(require, path, (entry) => JSON.stringify(entry.field));
    for (const entry of require) {
      selector(entry.field, path, sources);
      for (const value of entry.values ?? []) {
        if (
          entry.type === "boolean"
            ? typeof value !== "boolean"
            : entry.type === "integer"
              ? typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
              : typeof value !== "string" || !value.length || value.length > 200
        )
          fail(path, "incompatible-requirement");
        if (
          (entry.type === "identifier" || entry.type === "conversation") &&
          (typeof value !== "string" ||
            !(
              entry.type === "conversation"
                ? /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u
                : /^[A-Za-z0-9_-]{1,200}$/u
            ).test(value))
        )
          fail(path, "incompatible-requirement");
      }
    }
  };
  unique(facts, "$.discovery.facts", (fact) => fact.id);
  unique(channels, "$.hooks.channels", (channel) => channel.id);
  unique(manifest.files, "$.files", (file) => file.name);
  unique(manifest.launch.order, "$.launch.order");
  unique(manifest.attention.rules, "$.attention.rules", (rule) => rule.id);
  unique(metadata, "$.setup.status.metadata", (entry) => entry.id);
  unique(manifest.resumePaste, "$.resumePaste", (entry) => `${entry.command} ${entry.selector}`);
  const available = [...ENGINE];
  for (const fact of facts) {
    if (ENGINE.includes(fact.id) || STATUS.includes(fact.id))
      fail("$.discovery.facts", "reserved-id");
    condition(fact.when, "$.discovery.facts", `fact:${fact.id}`, available);
    available.push(fact.id);
  }
  const earlier: string[] = [];
  for (const [index, channel] of channels.entries()) {
    const path = `$.hooks.channels[${String(index)}]`;
    const owner = `channel:${channel.id}`;
    condition(channel.when, `${path}.when`, owner, available, ["facts"], earlier);
    if (channel.observer.transport === "external" && channel.arguments.length !== 0)
      fail(path, "incompatible-combination");
    const mapping = channel.mapping;
    if (
      mapping.event.source === "header" &&
      mapping.cases.some((entry) => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(entry.event))
    )
      fail(path, "incompatible-combination");
    selector(mapping.session, `${path}.mapping.session`, ["payload"]);
    selector(mapping.event, `${path}.mapping.event`, ["payload", "header"]);
    if (mapping.event.source === "header" && mapping.event.path[0] !== "X-Foom-Event")
      fail(path, "incompatible-selector");
    if (mapping.sequence) {
      selector(mapping.sequence, `${path}.mapping.sequence`, ["header"]);
      if (mapping.sequence.path[0] !== "X-Foom-Sequence") fail(path, "incompatible-selector");
    }
    if (Boolean(mapping.sequence) !== channel.observer.sequence)
      fail(path, "incompatible-combination");
    if (mapping.dedupe) selector(mapping.dedupe, `${path}.mapping.dedupe`, ["payload"]);
    if (
      channel.observer.transport === "argv-last" &&
      (channel.observer.response !== "silent" ||
        channel.observer.sequence ||
        mapping.event.source === "header")
    )
      fail(path, "incompatible-combination");
    if (channel.observer.delivery === "detached" && channel.observer.transport !== "stdin")
      fail(path, "incompatible-combination");
    if (
      channel.observer.placement === "plugin" &&
      (!manifest.setup?.status.ownership || channel.arguments.length !== 0)
    )
      fail(path, "incompatible-combination");
    if (
      channel.observer.protocol === "ordered-v2" &&
      (manifest.hooks?.channels.length !== 1 ||
        channel.observer.placement !== "plugin" ||
        channel.observer.transport !== "stdin" ||
        (channel.observer.version !== 2 && channel.observer.version !== 3) ||
        channel.observer.response !== "empty-json-first" ||
        channel.observer.delivery !== "detached" ||
        channel.observer.timeoutMs !== 1000 ||
        !channel.observer.sequence ||
        channel.observer.commandArguments.length !== 0)
    )
      fail(path, "incompatible-combination");
    unique(mapping.cases, `${path}.mapping.cases`, (entry) => entry.id);
    const shared = new Map<string, string>();
    const priorCases: typeof mapping.cases = [];
    for (const entry of mapping.cases) {
      const casePath = `${path}.mapping.cases`;
      requirements(entry.require, casePath, ["payload", "header"]);
      condition(entry.when, casePath, owner, available, ["payload", "header", "facts"], earlier);
      const signature = JSON.stringify(entry.require);
      if (shared.has(entry.event) && shared.get(entry.event) !== signature)
        fail(casePath, "incompatible-requirement");
      shared.set(entry.event, signature);
      unique(entry.facts, casePath, (fact) => fact.name);
      for (const fact of entry.facts) {
        selector(fact.field, casePath, ["payload"]);
        const requirement = entry.require.find(
          (requirement) => JSON.stringify(requirement.field) === JSON.stringify(fact.field),
        );
        if (!requirement || requirement.type !== (fact.name === "fullyIdle" ? "boolean" : "string"))
          fail(casePath, "incompatible-requirement");
        if (
          fact.name === "terminationReason" &&
          (!requirement.values?.length ||
            requirement.values.some(
              (value) =>
                typeof value !== "string" ||
                !["model_stop", "max_steps_exceeded", "error"].includes(
                  String(fact.aliases?.[value] ?? value),
                ),
            ))
        )
          fail(casePath, "incompatible-requirement");
        if (fact.aliases)
          for (const [alias, value] of Object.entries(fact.aliases)) {
            if (
              !(requirement.type === "boolean"
                ? ["true", "false"].includes(alias) &&
                  (requirement.values === undefined ||
                    requirement.values.some((value) => String(value) === alias))
                : requirement.values?.includes(alias)) ||
              (fact.name === "fullyIdle"
                ? typeof value !== "boolean"
                : typeof value !== "string" ||
                  !["model_stop", "max_steps_exceeded", "error"].includes(value))
            )
              fail(casePath, "incompatible-requirement");
          }
      }
      if (
        entry.recoverTurn &&
        (entry.action !== "classify" ||
          !entry.facts.some((fact) => fact.name === "fullyIdle") ||
          !entry.facts.some((fact) => fact.name === "terminationReason"))
      )
        fail(casePath, "incompatible-combination");
      if (entry.recoverTurn) {
        const idle = entry.facts.find((fact) => fact.name === "fullyIdle");
        const reason = entry.facts.find((fact) => fact.name === "terminationReason");
        const idleGuard = entry.when?.all?.some(
          (test) =>
            typeof test.field !== "string" &&
            JSON.stringify(test.field) === JSON.stringify(idle?.field) &&
            test.op === "eq" &&
            test.value === true,
        );
        const reasonRequirement = entry.require.find(
          (requirement) => JSON.stringify(requirement.field) === JSON.stringify(reason?.field),
        );
        if (!idleGuard || idle?.aliases?.["true"] === false)
          fail(casePath, "incompatible-combination");
        for (const value of reasonRequirement?.values ?? []) {
          if (typeof value !== "string" || (reason?.aliases?.[value] ?? value) === "model_stop")
            continue;
          const excludes = (test: ManifestCondition["all"]) =>
            test?.some(
              (test) =>
                typeof test.field !== "string" &&
                JSON.stringify(test.field) === JSON.stringify(reason?.field) &&
                ((test.op === "eq" && test.value !== value) ||
                  (test.op === "in" && Array.isArray(test.value) && !test.value.includes(value))),
            ) ?? false;
          const stoppedEarlier = priorCases.some(
            (previous) =>
              previous.event === entry.event &&
              previous.action === "failed" &&
              previous.when?.any === undefined &&
              previous.when?.all?.length === 1 &&
              previous.when.all.some(
                (test) =>
                  typeof test.field !== "string" &&
                  JSON.stringify(test.field) === JSON.stringify(reason?.field) &&
                  ((test.op === "eq" && test.value === value) ||
                    (test.op === "in" && Array.isArray(test.value) && test.value.includes(value))),
              ),
          );
          if (!excludes(entry.when?.all) && !stoppedEarlier)
            fail(casePath, "incompatible-combination");
        }
      }
      priorCases.push(entry);
      entry.endsTurn ??= entry.action === "classify" || entry.action === "failed";
      if (
        (entry.endsTurn && entry.action !== "classify" && entry.action !== "failed") ||
        (entry.recoverTurn && !entry.endsTurn)
      )
        fail(casePath, "incompatible-combination");
    }
    earlier.push(channel.id);
  }
  for (const stage of ["arguments", "display", "resume", "mcp"] as const)
    condition(manifest.launch[stage]?.when, `$.launch.${stage}.when`, "launch", available);
  const environmentNames = new Set<string>();
  for (const [index, entry] of (manifest.launch.environment ?? []).entries()) {
    const path = `$.launch.environment[${String(index)}]`;
    const name = entry.name.toUpperCase();
    if (environmentNames.has(name)) fail(`${path}.name`, "duplicate-environment");
    environmentNames.add(name);
    condition(entry.when, `${path}.when`, "launch", available);
  }
  condition(manifest.launch.guidance?.when, "$.launch.guidance.when", "launch", available);
  if (manifest.launch.prompt?.requires)
    reference(manifest.launch.prompt.requires, "$.launch.prompt.requires", "launch", available);
  for (const file of manifest.files) condition(file.when, "$.files", "launch", available);
  if (manifest.launch.guidance && !manifest.launch.prompt)
    fail("$.launch.guidance", "incompatible-combination");
  for (const [merge, tools] of [
    [manifest.launch.guidance?.merge, false],
    [manifest.launch.toolPermissions?.merge, true],
  ] as const) {
    if (!merge) continue;
    unique(merge.flags, "$.launch");
    if (
      !merge.flags.includes(merge.output) ||
      (tools
        ? merge.separators !== "whitespace-comma-parentheses"
        : merge.separators === "whitespace-comma-parentheses")
    )
      fail("$.launch", "incompatible-combination");
  }
  if (manifest.launch.toolPermissions)
    unique(manifest.launch.toolPermissions.names, "$.launch.toolPermissions.names");
  for (const list of [manifest.reservedArguments, manifest.bypassArguments])
    for (const matcher of list) {
      if (matcher.flag) {
        unique(matcher.forms, "$.reservedArguments");
        if (matcher.forms.includes("attached-short") && !/^-[A-Za-z]$/u.test(matcher.flag))
          fail("$.reservedArguments", "incompatible-combination");
        if (matcher.value !== undefined && matcher.forms.includes("exact"))
          fail("$.reservedArguments", "incompatible-combination");
      }
      if (matcher.override) {
        unique(matcher.override.flags, "$.reservedArguments");
        unique(matcher.override.keys, "$.reservedArguments");
      }
    }
  unique(manifest.bypassEnvironment, "$.bypassEnvironment", (entry) => entry.name.toUpperCase());
  for (const entry of manifest.bypassEnvironment) {
    if (
      /^(?:FOOM_|DYLD_|ELECTRON_)/iu.test(entry.name) ||
      [
        "CLAUDECODE",
        "TERM",
        "COLORTERM",
        "TERM_PROGRAM",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "NODE_OPTIONS",
        "BASH_ENV",
        "ENV",
        "PROMPT_COMMAND",
        "CONSTRUCTOR",
        "PROTOTYPE",
        "__PROTO__",
      ].includes(entry.name.toUpperCase())
    )
      fail("$.bypassEnvironment", "reserved-environment");
    if (entry.match === "values" ? !entry.values?.length : entry.values !== undefined)
      fail("$.bypassEnvironment", "incompatible-combination");
    if (entry.values) unique(entry.values, "$.bypassEnvironment");
  }
  for (const rule of manifest.attention.rules) {
    for (const matcher of [rule.match, ...rule.not]) {
      if (!matcher.contains.length && !matcher.regex.length)
        fail("$.attention.rules", "invalid-value");
      for (const pattern of matcher.regex)
        try {
          boundedRegex(pattern);
        } catch {
          fail("$.attention.rules", "unsafe-regex");
        }
    }
  }
  manifest.attention.rules.sort((a, b) => b.priority - a.priority);
  unique(manifest.execution.completionChannels, "$.execution.completionChannels");
  for (const id of manifest.execution.completionChannels) {
    const channel = channels.find((entry) => entry.id === id);
    if (!channel || !channel.mapping.cases.some((entry) => entry.endsTurn))
      fail("$.execution.completionChannels", "dangling-reference");
  }
  if (channels.length && !manifest.execution.completionChannels.length)
    fail("$.execution.completionChannels", "incompatible-combination");
  unique(manifest.execution.providerRules, "$.execution.providerRules");
  for (const id of manifest.execution.providerRules)
    if (!manifest.attention.rules.some((rule) => rule.id === id && rule.state === "blocked"))
      fail("$.execution.providerRules", "dangling-reference");
  if (manifest.health) {
    const health = manifest.health;
    const channel = channels.find((entry) => entry.id === health.channel);
    if (!channel) fail("$.health.channel", "dangling-reference");
    edge("health", `channel:${channel.id}`);
    if (
      !channel.mapping.cases.some(
        (entry) => entry.action === "ready" && health.requiredEvents.includes(entry.id),
      )
    )
      fail("$.health", "incompatible-combination");
    unique(health.requiredEvents, "$.health.requiredEvents");
    for (const event of [...health.requiredEvents, health.completionEvent, health.promptEvent])
      if (!channel.mapping.cases.some((entry) => entry.id === event))
        fail("$.health", "dangling-reference");
    if (
      !health.requiredEvents.includes(health.completionEvent) ||
      !health.requiredEvents.includes(health.promptEvent) ||
      !channel.mapping.cases.some(
        (entry) => entry.id === health.completionEvent && entry.endsTurn,
      ) ||
      !channel.mapping.cases.some(
        (entry) => entry.id === health.promptEvent && entry.action === "working",
      )
    )
      fail("$.health", "incompatible-combination");
  }
  if (manifest.setup) {
    const setup = manifest.setup;
    unique(setup.actions, "$.setup.actions", (action) => action.id);
    for (const entry of setup.status.cases)
      condition(
        entry.when,
        "$.setup.status.cases",
        "setup",
        [...STATUS, ...available.filter((fact) => fact !== "setupState")],
        ["facts", "probe", "metadata"],
      );
    if (
      setup.status.probe &&
      (![JSON.stringify(["plugin", "list"]), JSON.stringify(["plugin", "list", "--json"])].includes(
        JSON.stringify(setup.status.probe.arguments),
      ) ||
        (setup.status.probe.fallbackArguments !== undefined &&
          (JSON.stringify(setup.status.probe.arguments) !==
            JSON.stringify(["plugin", "list", "--json"]) ||
            JSON.stringify(setup.status.probe.fallbackArguments) !==
              JSON.stringify(["plugin", "list"]))))
    )
      fail("$.setup.status.probe.arguments", "incompatible-combination");
    if (setup.status.ownership) {
      if (!setup.status.probe) fail("$.setup.status.probe", "incompatible-combination");
      const ownership = setup.status.ownership;
      if (
        !/^\.[A-Za-z][A-Za-z0-9_-]*\/config\/plugins\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(
          ownership.directory,
        )
      )
        fail("$.setup.status.ownership.directory", "unsafe-file");
      const target = ownership.directory.split("/").at(-1);
      if (
        !ownership.require.some(
          (requirement) =>
            requirement.type === "string" &&
            requirement.field.source === "metadata" &&
            JSON.stringify(requirement.field.path) ===
              JSON.stringify([ownership.manifest, "name"]) &&
            requirement.values?.length === 1 &&
            requirement.values[0] === target,
        )
      )
        fail("$.setup.status.ownership.require", "incompatible-requirement");
      if (
        !metadata.some(
          (entry) =>
            entry.id === ownership.manifest && entry.path === `${ownership.directory}/plugin.json`,
        )
      )
        fail("$.setup.status.ownership", "dangling-reference");
      requirements(ownership.require, "$.setup.status.ownership.require", ["metadata"]);
      for (const field of [ownership.versionField, ownership.disabledField, ownership.enabledField])
        if (field) selector(field, "$.setup.status.ownership", ["metadata"]);
      if (ownership.versionField.path[0] !== ownership.manifest || !ownership.require.length)
        fail("$.setup.status.ownership", "incompatible-combination");
      for (const entry of metadata) {
        const parent = ownership.directory.split("/").slice(0, -2).join("/");
        if (
          entry.path !== `${ownership.directory}/plugin.json` &&
          entry.path !== `${parent}/config.json`
        )
          fail("$.setup.status.metadata", "unsafe-file");
      }
    } else if (metadata.length || setup.actions.some((action) => action.kind === "command"))
      fail("$.setup.status", "incompatible-combination");
    for (const action of setup.actions) {
      condition(action.when, "$.setup.actions.when", "action", available);
      if (action.kind === "command") {
        const target = setup.status.ownership?.directory.split("/").at(-1);
        const args = action.arguments ?? [];
        const operation = args[1];
        const allowedStates =
          operation === "install"
            ? ["not-installed", "outdated"]
            : operation === "enable"
              ? ["disabled"]
              : ["installed", "outdated", "disabled"];
        const stateGuard = action.when.all?.some(
          (test) =>
            test.field === "setupState" &&
            ((test.op === "eq" &&
              typeof test.value === "string" &&
              allowedStates.includes(test.value)) ||
              (test.op === "in" &&
                Array.isArray(test.value) &&
                test.value.length > 0 &&
                test.value.every(
                  (value) => typeof value === "string" && allowedStates.includes(value),
                ))),
        );
        if (
          args.length !== 3 ||
          args[0] !== "plugin" ||
          !["install", "reinstall", "enable", "uninstall"].includes(operation ?? "") ||
          args[2] !==
            (["install", "reinstall"].includes(operation ?? "") ? "{pluginDir}" : target) ||
          ![
            JSON.stringify(["plugin", "list"]),
            JSON.stringify(["plugin", "list", "--json"]),
          ].includes(JSON.stringify(action.statusProbe)) ||
          !stateGuard
        )
          fail("$.setup.actions", "incompatible-combination");
      }
      if (
        action.kind === "command"
          ? !action.arguments?.length ||
            action.instructions !== undefined ||
            !Array.isArray(action.statusProbe) ||
            !action.statusProbe.length
          : action.arguments !== undefined ||
            action.instructions === undefined ||
            action.statusProbe !== "observed-health" ||
            !manifest.health
      )
        fail("$.setup.actions", "incompatible-combination");
    }
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (node: string) => {
    if (visiting.has(node)) fail("$.discovery.facts", "fact-cycle");
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) visit(node);
  validateTemplates(manifest);
}
