import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseSettingsPatch } from "../../setup/settings";
import { legacyBypassIdentities } from "../../agents/providers/bundled";
import { isConfigSetting, migrateAppearanceSettings } from "../../../shared/config-settings";
import { parseSettingsFile } from "../../../shared/config-files";
import { record } from "../../../shared/remote-agent-protocol";
import { validAgentId } from "../../../shared/providers/catalog";
import { importLegacyGroup } from "./importer";
import type { ProfileDatabase } from "./database";
import type { DataTransaction } from "./commands";
import * as tables from "./schema";

/** Main-owned patches only. Host registration and consent have distinct commands. */
export function writeSettings(db: DataTransaction, input: unknown): void {
  const patch = parseSettingsPatch(input);
  if (
    patch.registeredHosts !== undefined ||
    patch.agentBypassAcknowledged !== undefined ||
    patch.agentBypassIdentities !== undefined
  )
    throw new Error("Use the owning domain command");
  for (const [key, value] of Object.entries(patch))
    db.insert(tables.profileSettings)
      .values({ key, value: JSON.stringify(value) })
      .onConflictDoUpdate({
        target: tables.profileSettings.key,
        set: { value: JSON.stringify(value) },
      })
      .run();
}
export function saveProfileSettings(database: ProfileDatabase, input: unknown) {
  return database.write((db) => {
    writeSettings(db, input);
  });
}
export function saveAgentConsent(
  database: ProfileDatabase,
  agent: string,
  acknowledged: boolean,
  identity: string | null,
) {
  return database.write((db) => {
    if (
      !validAgentId(agent) ||
      typeof acknowledged !== "boolean" ||
      (identity !== null && !/^[a-f0-9]{64}$/u.test(identity))
    )
      throw new Error("Invalid consent");
    db.insert(tables.agentConsents)
      .values({ agent, acknowledged: Number(acknowledged), identity })
      .onConflictDoUpdate({
        target: tables.agentConsents.agent,
        set: { acknowledged: Number(acknowledged), identity },
      })
      .run();
  });
}

export function importSettingsRows(db: DataTransaction, text: string | null | undefined) {
  let accepted = 0;
  let quarantined = 0;
  const reject = (source: string, position = -1) => {
    db.insert(tables.quarantine).values({ source, position, reason: "invalid" }).run();
    quarantined++;
  };
  if (text == null) return { accepted, quarantined };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    reject("settings.json");
    return { accepted, quarantined };
  }
  if (!record(raw) || (raw["version"] !== 1 && raw["version"] !== 2))
    throw new Error("Unsupported legacy settings version");
  if (!record(raw["settings"])) {
    reject("settings.json#settings");
    return { accepted, quarantined };
  }
  const data = migrateAppearanceSettings(raw["settings"]);
  const acknowledged = data["agentBypassAcknowledged"];
  const identities = data["agentBypassIdentities"];
  for (const [position, [key, value]] of Object.entries(data).entries()) {
    if (["registeredHosts", "agentBypassAcknowledged", "agentBypassIdentities"].includes(key))
      continue;
    try {
      // V2 config keys on disk are not an accepted external config baseline.
      // agentArguments is a documented pending profile-to-baseline migration.
      if (raw["version"] === 2 && isConfigSetting(key) && key !== "agentArguments")
        throw new Error("Unapproved projection");
      writeSettings(db, { [key]: value });
      accepted++;
    } catch (error) {
      if (error instanceof Error && error.cause !== undefined) throw error;
      reject("settings.json#settings", position);
    }
  }
  try {
    const consent = parseSettingsPatch({
      ...(acknowledged === undefined ? {} : { agentBypassAcknowledged: acknowledged }),
      ...(identities === undefined ? {} : { agentBypassIdentities: identities }),
    });
    const agents = new Set([
      ...Object.keys(consent.agentBypassAcknowledged ?? {}),
      ...Object.keys(consent.agentBypassIdentities ?? {}),
    ]);
    for (const agent of agents) {
      const yes = consent.agentBypassAcknowledged?.[agent] === true;
      // Historical built-ins can retain only their historical disclosure identity.
      const identity =
        consent.agentBypassIdentities?.[agent] ??
        (yes ? legacyBypassIdentities[agent] : undefined) ??
        null;
      db.insert(tables.agentConsents)
        .values({ agent, acknowledged: Number(yes), identity })
        .run();
      accepted++;
    }
  } catch {
    reject("settings.json#consents");
  }
  const metadata: Record<string, unknown> = { configVersion: raw["version"] };
  if (raw["remoteProfile"] !== undefined) {
    if (typeof raw["remoteProfile"] === "string" && /^[a-f0-9]{32}$/u.test(raw["remoteProfile"]))
      metadata["remoteProfile"] = raw["remoteProfile"];
    else reject("settings.json#remoteProfile");
  }
  if (raw["configText"] !== undefined || raw["configDigest"] != null) {
    try {
      const text = raw["configText"];
      const digest = raw["configDigest"];
      if (
        typeof text !== "string" ||
        Buffer.byteLength(text) > 65536 ||
        typeof digest !== "string" ||
        createHash("sha256").update(text).digest("hex") !== digest
      )
        throw new Error("Invalid baseline");
      // Keep the accepted values as a closed baseline copy, with a matching
      // digest so restart can use it when the external file is a held proposal.
      const projection = parseSettingsFile(text);
      const baseline = JSON.stringify({ kind: "settings", ...projection });
      // Every normalized projection must survive the restart parser, including
      // its byte limit; source validity alone does not guarantee this.
      if (!isDeepStrictEqual(parseSettingsFile(baseline), projection))
        throw new Error("Invalid baseline round trip");
      metadata["configText"] = baseline;
      metadata["configDigest"] = createHash("sha256").update(baseline).digest("hex");
    } catch {
      reject("settings.json#configBaseline");
    }
  }
  if (raw["themeDigests"] !== undefined) {
    const themes = raw["themeDigests"];
    if (
      record(themes) &&
      Object.keys(themes).length <= 100 &&
      Object.entries(themes).every(
        ([path, hash]) =>
          /^themes\/[^/]{1,200}$/u.test(path) &&
          typeof hash === "string" &&
          /^[a-f0-9]{64}$/u.test(hash),
      )
    )
      metadata["themeDigests"] = themes;
    else reject("settings.json#themeDigests");
  }
  for (const [key, value] of Object.entries(metadata)) {
    db.insert(tables.profileMetadata)
      .values({ key, value: JSON.stringify(value) })
      .run();
    accepted++;
  }
  return { accepted, quarantined };
}
export function importProfileSettings(database: ProfileDatabase, profile: string) {
  return importLegacyGroup(
    database,
    profile,
    "settings-consents-v1",
    ["settings.json"],
    (db, input) => importSettingsRows(db, input["settings.json"]),
  );
}
