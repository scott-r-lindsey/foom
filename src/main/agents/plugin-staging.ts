import { agyMcpFiles } from "./agy-mcp";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { readdir, realpath, stat } from "node:fs/promises";
import type { AgentManifestV2 } from "../../shared/agent-manifest-v2";
import { manifestJson } from "../../shared/agent-manifest-json";
import { readSetupFile, record } from "./setup-metadata";
import { dataContainer } from "../../shared/agent-manifest-container";
import {
  createPrivateFile,
  privateDirectory,
  verifyPrivate,
} from "../../node-common/private-files";
import { observerAssets, observerInvocation, observerVersion } from "./providers/v2-observers";
import { readOwnedFile } from "./providers/v2-files";
import { expandV2, selected, type Facts } from "../../shared/agent-launch-values";

/** Platform-specific definitions. The normalized root keeps definition identity independent of the profile. */
export function pluginContent(
  model: AgentManifestV2,
  facts: Facts,
  windows = process.platform === "win32",
  directory?: string,
) {
  const files = model.files.filter((file) => file.scope === "plugin" && selected(file.when, facts));
  const assets: { name: string; content: string }[] = [];
  const values: Record<string, string | string[] | number> = {};
  for (const channel of model.hooks?.channels ?? []) {
    if (
      !files.some((file) =>
        new RegExp(`\\{observer(?:Command|Argv|Version):${channel.id}(?:[.:}])`, "u").test(
          file.content,
        ),
      )
    )
      continue;
    if (channel.observer.placement !== "plugin") throw Error("Invalid plugin observer placement");
    const folder = channel.observer.protocol === "ordered-v2" ? "" : `observers/${channel.id}`;
    for (const [name, content] of Object.entries(observerAssets(channel, windows)))
      assets.push({ name: folder ? `${folder}/${name}` : name, content });
    if (channel.observer.protocol === "ordered-v2" && channel.observer.version === 4)
      for (const [name, content] of Object.entries(
        agyMcpFiles(windows, directory ?? "/FOOM_INSTALLED_PLUGIN_ROOT"),
      ))
        assets.push({ name, content });
    const script = `${directory ?? "/FOOM_INSTALLED_PLUGIN_ROOT"}/${folder ? `${folder}/` : ""}observer.${windows ? "ps1" : "sh"}`;
    values[`observerVersion:${channel.id}`] = observerVersion(channel, windows);
    const add = (event?: string) => {
      const suffix = event ? `.${event}` : "";
      const invocation = observerInvocation(
        script,
        [...channel.observer.commandArguments, ...(event ? [event] : [])],
        windows,
        false,
      );
      values[`observerCommand:${channel.id}${suffix}`] = invocation.command;
      values[`observerArgv:${channel.id}${suffix}`] = invocation.argv;
    };
    add();
    for (const event of new Set(channel.mapping.cases.map((entry) => entry.event)))
      if (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(event)) add(event);
  }
  const content = files.map((file) => {
    const expanded = expandV2(file.content, values);
    dataContainer(expanded, file.format, "$.files", true);
    return { name: file.name, content: expanded };
  });
  if (!content.some((file) => file.name === "plugin.json"))
    throw new Error("Missing staged plugin manifest");
  const names = [...content, ...assets].map((file) => file.name);
  if (
    names.some((name, index) =>
      names.some(
        (other, otherIndex) =>
          otherIndex !== index && (other === name || other.startsWith(`${name}/`)),
      ),
    )
  )
    throw Error("Conflicting staged plugin files");
  content.push(...assets);
  const fingerprint: string =
    directory === undefined
      ? createHash("sha256").update(JSON.stringify(content)).digest("hex")
      : pluginContent(model, facts, windows).fingerprint;
  // CLI-owned metadata carries the definition identity; no launch data enters the hash.
  if (assets.length) {
    const manifest = content.find((file) => file.name === "plugin.json");
    if (manifest) {
      const metadata = manifestJson(manifest.content);
      if (!record(metadata)) throw Error("Invalid staged plugin manifest");
      manifest.content = JSON.stringify({ ...metadata, foomStagingFingerprint: fingerprint });
    }
  }
  return { content, fingerprint, observers: assets.length > 0 };
}

async function installedDirectory(model: AgentManifestV2, home: string) {
  const relative = model.setup?.status.ownership?.directory;
  if (!relative) throw Error("Missing plugin ownership");
  return { directory: join(await realpath(home), relative), relative };
}

/** Only exact native spellings qualify for an identity check; never normalize untrusted paths. */
export function pluginPathMatches(
  reported: unknown,
  expected: string,
  platform = process.platform,
): reported is string {
  if (
    typeof reported !== "string" ||
    reported.length > 4096 ||
    /[\p{C}\u2028\u2029]/u.test(reported)
  )
    return false;
  return platform === "win32" || platform === "darwin"
    ? reported.toLowerCase() === expected.toLowerCase()
    : reported === expected;
}

/** Reported paths may confirm fixed ownership, but never select inventory reads. */
export async function validateInstalledPluginPath(
  model: AgentManifestV2,
  home: string,
  reported: unknown,
  platform = process.platform,
): Promise<void> {
  const { directory, relative } = await installedDirectory(model, home);
  if (
    typeof reported !== "string" ||
    ![directory, join(home, relative)].some((expected) =>
      pluginPathMatches(reported, expected, platform),
    )
  )
    throw Error("Unrecognized plugin install path");
  const [actual, owned] = await Promise.all([realpath(reported), realpath(directory)]);
  // realpath can preserve case on case-insensitive volumes. Compare filesystem identities,
  // not folded path strings, so case-sensitive macOS volumes also fail closed.
  const [actualInfo, ownedInfo] = await Promise.all([
    stat(actual, { bigint: true }),
    stat(owned, { bigint: true }),
  ]);
  if (actualInfo.dev !== ownedInfo.dev || actualInfo.ino !== ownedInfo.ino)
    throw Error("Unrecognized plugin install path");
}

/** Read only the fixed owned inventory. Untrusted list paths never select files or commands. */
export async function installedPluginCurrent(
  model: AgentManifestV2,
  facts: Facts,
  home: string,
): Promise<boolean> {
  try {
    const { directory, relative } = await installedDirectory(model, home);
    const expected = pluginContent(model, facts, process.platform === "win32", directory);
    for (const file of expected.content) {
      if (file.name === "plugin.json") continue; // CLI-owned metadata is checked separately.
      if (
        (await readSetupFile(home, `${relative}/${file.name}`, Buffer.byteLength(file.content))) !==
        file.content
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Immutable, content-addressed staging under Foom's profile, never the agent's home. */
export async function stagePlugin(
  model: AgentManifestV2,
  root: string,
  facts: Facts,
  windows = process.platform === "win32",
  home = homedir(),
) {
  const { fingerprint } = pluginContent(model, facts, windows);
  const parent = await privateDirectory(root, "agent-plugins");
  const directory = await privateDirectory(parent, fingerprint);
  const installed = await installedDirectory(model, home);
  const { content } = pluginContent(model, facts, windows, installed.directory);
  for (const file of content) {
    let folder = directory;
    for (const component of file.name.split("/").slice(0, -1))
      folder = await privateDirectory(folder, component);
    const target = join(directory, file.name);
    let handle;
    try {
      handle = await createPrivateFile(target);
      await handle.writeFile(file.content);
      await handle.sync();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    } finally {
      await handle?.close();
    }
  }
  const verify = async () => {
    await verifyPrivate(parent, true);
    await verifyPrivate(directory, true);
    const expected = new Set<string>();
    for (const file of content) {
      const components = file.name.split("/");
      for (let count = 1; count <= components.length; count++)
        expected.add(components.slice(0, count).join("/"));
    }
    const walk = async (relative = ""): Promise<void> => {
      const entries = await readdir(join(directory, relative), { withFileTypes: true });
      if (entries.length > expected.size) throw new Error("Staged plugin changed");
      for (const entry of entries) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (!expected.has(name) || entry.isSymbolicLink()) throw new Error("Staged plugin changed");
        if (entry.isDirectory()) await walk(name);
      }
    };
    await walk();
    for (const file of content) {
      let folder = directory;
      for (const component of file.name.split("/").slice(0, -1)) {
        folder = join(folder, component);
        await verifyPrivate(folder, true);
      }
      const target = join(directory, file.name);
      if ((await readOwnedFile(target, Buffer.byteLength(file.content))) !== file.content)
        throw new Error("Staged plugin changed");
    }
  };
  await verify();
  const disclosed = content.map((file) => {
    const hash = createHash("sha256").update(file.content).digest("hex");
    const size = Buffer.byteLength(file.content);
    return {
      bytes: `${file.name} · SHA-256 ${hash}\n${file.name}: ${JSON.stringify(file.content)}`,
      summary: {
        text: `${file.name} · ${hash.slice(0, 12)} · ${String(size)} B`,
        title: `${file.name} · SHA-256 ${hash} · ${String(size)} B`,
      },
    };
  });
  return {
    directory,
    files: disclosed.map((file) => file.bytes),
    summary: [
      {
        text: `${String(content.length)} files · ${String(content.reduce((total, file) => total + Buffer.byteLength(file.content), 0))} bytes`,
      },
      ...disclosed.map((file) => file.summary),
    ],
    verify,
  };
}
