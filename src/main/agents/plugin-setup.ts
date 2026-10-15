import { pluginContent } from "./plugin-staging";
import { setupOffers } from "./setup-offers";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { AgentManifestV2 } from "../../shared/agent-manifest-v2";
import type { AgentSetupState, AgentSetupStatus } from "../../shared/agent-setup";
import type { DialogContent } from "../../shared/confirmation";
import { conversationId } from "../../shared/conversation";
import { manifestJson } from "../../shared/agent-manifest-json";
import { selected, type Facts } from "./providers/v2-values";
import { metadataIdentity, readSetupMetadata, record, select } from "./setup-metadata";

const execute = promisify(execFile);
const limits = {
  timeout: 5000,
  maxBuffer: 65536,
  encoding: "utf8",
  killSignal: "SIGKILL",
} as const;
const locks = new Set<string>();
type Setup = NonNullable<AgentManifestV2["setup"]>;
type Action = Setup["actions"][number];
interface Snapshot {
  state: AgentSetupState;
  facts: Facts;
  identity: string;
}
export class PluginSetup {
  constructor(
    private readonly home = homedir(),
    private readonly run: (
      executable: string,
      args: readonly string[],
      options: typeof limits & { signal?: AbortSignal },
    ) => Promise<{ stdout: string }> = execute,
    private readonly caseInsensitive = process.platform === "win32" ||
      process.platform === "darwin",
  ) {}

  private async inspect(
    model: AgentManifestV2,
    executable: string,
    facts: Facts,
    signal?: AbortSignal,
  ): Promise<Snapshot> {
    const setup = model.setup;
    if (!setup) throw Error("Missing setup");
    const status = setup.status;
    let probe: unknown;
    if (status.probe) {
      const { stdout } = await this.run(executable, status.probe.arguments, {
        ...limits,
        ...(signal ? { signal } : {}),
      }).catch(() => {
        throw new Error("Plugin setup status unavailable. Scan again.");
      });
      if (Buffer.byteLength(stdout) > 65536) throw new Error("Invalid setup probe");
      probe =
        status.probe.empty && stdout.trim() === status.probe.empty.text
          ? status.probe.empty.value
          : manifestJson(stdout);
      if (
        !record(probe) ||
        !Array.isArray(probe["imports"]) ||
        probe["imports"].length > 64 ||
        !probe["imports"].every(
          (entry: unknown) =>
            record(entry) &&
            typeof entry["name"] === "string" &&
            /^[^\p{C}\u2028\u2029]{1,64}$/u.test(entry["name"]),
        )
      )
        throw new Error("Invalid setup probe");
      // Discard everything except the documented names.
      probe = {
        imports: probe["imports"].map((entry: Record<string, unknown>) => ({
          name: entry["name"],
        })),
      };
    }
    const metadata: Record<string, unknown> = {};
    for (const entry of status.metadata) {
      const value = await readSetupMetadata(this.home, entry.path);
      if (value === undefined && !entry.optional) throw new Error("Missing setup metadata");
      if (value !== undefined && !record(value)) throw new Error("Invalid setup metadata");
      metadata[entry.id] = value;
    }
    const derived: Record<string, unknown> = { ...facts };
    const sources = { metadata, probe, facts: derived };
    const ownership = status.ownership;
    let directory: string | undefined;
    if (ownership) {
      directory = await metadataIdentity(this.home, ownership.directory, true);
      const target = ownership.directory.split("/").at(-1);
      const imports = record(probe) && Array.isArray(probe["imports"]) ? probe["imports"] : [];
      const listed = imports.some((entry: unknown) => record(entry) && entry["name"] === target);
      const manifest = metadata[ownership.manifest];
      const absent = directory === undefined && manifest === undefined && !listed;
      if (!absent) {
        if (
          directory === undefined ||
          !record(manifest) ||
          !ownership.require.every((requirement) => {
            const value = select(requirement.field, sources);
            const valid =
              requirement.type === "integer"
                ? typeof value === "number" && Number.isSafeInteger(value) && value >= 0
                : requirement.type === "boolean"
                  ? typeof value === "boolean"
                  : requirement.type === "conversation"
                    ? conversationId(value)
                    : requirement.type === "identifier"
                      ? typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(value)
                      : typeof value === "string" && value.length > 0 && value.length <= 200;
            return (
              valid &&
              (requirement.values === undefined ||
                requirement.values.some((candidate) => candidate === value))
            );
          })
        )
          throw new Error("Unrecognized plugin ownership");
        const version = select(ownership.versionField, sources);
        if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0)
          throw new Error("Invalid plugin version");
        const enabled = ownership.enabledField
          ? select(ownership.enabledField, sources)
          : undefined;
        const disabled = ownership.disabledField
          ? select(ownership.disabledField, sources)
          : undefined;
        if (
          (enabled !== undefined && typeof enabled !== "boolean") ||
          (disabled !== undefined && typeof disabled !== "boolean")
        )
          throw new Error("Invalid plugin switch");
        // A missing leaf is allowed; an explicitly malformed parent is not.
        for (const field of [ownership.enabledField, ownership.disabledField]) {
          if (!field) continue;
          for (let length = 1; length < field.path.length; length++) {
            const parent = select({ ...field, path: field.path.slice(0, length) }, sources);
            if (parent !== undefined && !record(parent)) throw new Error("Invalid plugin switch");
          }
        }
        const staged = model.hooks?.channels.some(
          (channel) => channel.observer.placement === "plugin",
        )
          ? pluginContent(model, facts)
          : undefined;
        Object.assign(derived, {
          stagingOutdated:
            staged?.observers === true && manifest["foomStagingFingerprint"] !== staged.fingerprint,
          owned: true,
          absent: false,
          version,
          disabled: enabled === undefined ? disabled === true : !enabled,
        });
      } else Object.assign(derived, { owned: false, absent: true });
    }
    let state =
      status.cases.find((entry) => selected(entry.when, derived, (field) => select(field, sources)))
        ?.state ?? status.default;
    if (state === "installed" && derived["stagingOutdated"] === true) state = "outdated";
    // Cases cannot turn unknown ownership into authority or disguise an absent installation.
    if (
      ownership &&
      (derived["absent"] === true ? state !== "not-installed" : state === "not-installed")
    )
      throw new Error("Invalid setup state");
    return {
      state,
      facts: { ...derived, setupState: state },
      identity: createHash("sha256")
        .update(JSON.stringify({ directory, metadata, probe, state }))
        .digest("hex"),
    };
  }

  async status(
    model: AgentManifestV2,
    executable: string,
    facts: Facts = {},
    derive: (state: AgentSetupState) => Facts = () => ({}),
  ): Promise<AgentSetupStatus> {
    if (!model.setup) return { state: "unavailable", actions: [] };
    try {
      const snapshot = await this.inspect(model, executable, facts);
      snapshot.facts = { ...snapshot.facts, ...derive(snapshot.state), setupState: snapshot.state };
      return {
        state: snapshot.state,
        ...(snapshot.state === "not-installed" &&
        model.setup.offer &&
        !setupOffers.answered(model.id)
          ? { offer: model.setup.offer.unansweredLabel }
          : {}),
        actions: model.setup.actions
          .filter(
            (action) =>
              (action.kind === "instructions" || snapshot.state !== "unavailable") &&
              selected(action.when, snapshot.facts),
          )
          .map(({ id, label }) => ({ id, label })),
      };
    } catch {
      return { state: "unavailable", actions: [] };
    }
  }

  /** All identity/consent inputs are main-owned. No terminal input or agent-home writes. */
  async change(input: {
    model: AgentManifestV2;
    executable: string;
    action: string;
    validate(): Promise<void>;
    facts(state?: AgentSetupState): Facts;
    confirm(content: DialogContent): Promise<boolean>;
    stage(): Promise<{ directory: string; files: readonly string[]; verify(): Promise<void> }>;
    signal: AbortSignal;
  }): Promise<void> {
    const { model, executable, signal } = input;
    const setup = model.setup;
    const action = setup?.actions.find((entry) => entry.id === input.action);
    if (!setup || !action) throw new Error("Unknown setup action");
    const key = JSON.stringify(
      [await realpath(this.home), setup.status.ownership?.directory ?? model.id].map((part) =>
        this.caseInsensitive ? part.toLowerCase() : part,
      ),
    );
    if (locks.has(key)) throw new Error("Plugin setup is busy");
    locks.add(key);
    try {
      const validate = async () => {
        signal.throwIfAborted();
        await input.validate();
        signal.throwIfAborted();
      };
      await validate();
      const before = await this.inspect(model, executable, input.facts(), signal);
      before.facts = { ...before.facts, ...input.facts(before.state), setupState: before.state };
      if (!selected(action.when, before.facts))
        throw new Error("Plugin setup changed. Scan again.");
      const executableIdentity = async () => {
        const info = await stat(executable);
        return JSON.stringify([
          await realpath(executable),
          info.dev,
          info.ino,
          info.size,
          info.mtimeMs,
          info.ctimeMs,
        ]);
      };
      const identity = await executableIdentity();
      const staging = action.arguments?.[1] === "install" ? await input.stage() : undefined;
      const args =
        action.arguments?.map((arg) =>
          arg === "{pluginDir}" ? (staging?.directory ?? "") : arg,
        ) ?? [];
      const accepted = await input.confirm(
        this.disclosure(model, action, executable, before.state, args, staging?.files ?? []),
      );
      await setupOffers.answer(model.id);
      if (!accepted) return;
      await validate();
      const after = await this.inspect(model, executable, input.facts(), signal);
      after.facts = { ...after.facts, ...input.facts(after.state), setupState: after.state };
      if (
        identity !== (await executableIdentity()) ||
        before.identity !== after.identity ||
        !selected(action.when, after.facts)
      )
        throw new Error("Plugin setup changed. Scan again.");
      await staging?.verify();
      await validate();
      if (action.kind === "instructions") return;
      // Independently guard mutation even if a case was authored incorrectly.
      const operation = args[1];
      const allowed =
        operation === "install"
          ? ["not-installed", "outdated"]
          : operation === "enable"
            ? ["disabled"]
            : ["installed", "outdated", "disabled"];
      const owned = after.facts["owned"] === true;
      const version = after.facts["version"];
      const safe =
        operation === "install"
          ? after.facts["absent"] === true ||
            (owned &&
              typeof version === "number" &&
              (version < (setup.status.ownership?.currentVersion ?? 0) ||
                after.facts["stagingOutdated"] === true) &&
              after.facts["disabled"] === false)
          : operation === "enable"
            ? owned && after.facts["disabled"] === true
            : owned;
      if (!safe || !allowed.includes(after.state))
        throw new Error("Plugin setup changed. Scan again.");
      try {
        await this.run(executable, args, { ...limits, signal });
        await validate();
        const result = await this.inspect(model, executable, input.facts(), signal);
        const installedVersion = result.facts["version"];
        const verified =
          operation === "uninstall"
            ? result.facts["absent"] === true
            : result.facts["owned"] === true &&
              (operation === "enable"
                ? result.facts["disabled"] === false
                : typeof installedVersion === "number" &&
                  installedVersion >= (setup.status.ownership?.currentVersion ?? 0) &&
                  result.facts["stagingOutdated"] !== true);
        if (!verified) throw new Error("Setup state did not change");
      } catch {
        throw new Error("Plugin setup command failed. Scan again to check its status.");
      }
    } finally {
      locks.delete(key);
    }
  }

  private disclosure(
    model: AgentManifestV2,
    action: Action,
    executable: string,
    state: string,
    args: string[],
    files: readonly string[],
  ): DialogContent {
    return {
      title: `${action.label} ${model.name} plugin?`,
      accept: action.label,
      glyph: "shield",
      detail:
        "Runs as you. Only the agent CLI changes its plugin installation. Foom never edits agent configuration or trust stores, types review commands, approves tools or stores credentials in plugins. Installed observers are inert without Foom launch credentials.",
      sections: [
        { label: "Action disclosure", items: [action.disclosure] },
        { label: "Executable and fixed arguments", arguments: true, items: [executable, ...args] },
        {
          label: "Installation and state",
          items: [
            model.id,
            model.setup?.status.ownership
              ? `~/${model.setup.status.ownership.directory}`
              : "No installation change",
            state,
            JSON.stringify(action.when),
          ],
        },
        {
          label: "Status and ownership checks",
          arguments: true,
          items: [JSON.stringify(model.setup?.status)],
        },
        { label: "Staged files (JSON-escaped bytes)", arguments: true, items: files },
        {
          label: "Instructions and removal",
          items: [
            action.instructions ?? "",
            ...(model.setup?.actions
              .filter((entry) => entry.arguments?.[1] === "uninstall")
              .map((entry) => JSON.stringify(entry.arguments)) ?? []),
          ],
        },
      ],
    };
  }
}
