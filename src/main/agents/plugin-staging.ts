import { createHash } from "node:crypto";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import type { AgentManifestV2 } from "../../shared/agent-manifest-v2";
import { manifestJson } from "../../shared/agent-manifest-json";
import { record } from "./setup-metadata";
import { dataContainer } from "../../shared/agent-manifest-container";
import { createPrivateFile, privateDirectory, verifyPrivate } from "../control/private-files";
import { observerAssets, observerInvocation, observerVersion } from "./providers/v2-observers";
import { readOwnedFile } from "./providers/v2-files";
import { expandV2, selected, type Facts } from "./providers/v2-values";

/** Pure platform-specific definitions. Commands stay relative when the CLI copies the plugin. */
export function pluginContent(
  model: AgentManifestV2,
  facts: Facts,
  windows = process.platform === "win32",
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
    const folder = `observers/${channel.id}`;
    for (const [name, content] of Object.entries(observerAssets(channel, windows)))
      assets.push({ name: `${folder}/${name}`, content });
    const script = `./${folder}/observer.${windows ? "ps1" : "sh"}`;
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
  const fingerprint = createHash("sha256").update(JSON.stringify(content)).digest("hex");
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

/** Immutable, content-addressed staging under Foom's profile, never the agent's home. */
export async function stagePlugin(
  model: AgentManifestV2,
  root: string,
  facts: Facts,
  windows = process.platform === "win32",
) {
  const { content, fingerprint } = pluginContent(model, facts, windows);
  const parent = await privateDirectory(root, "agent-plugins");
  const directory = await privateDirectory(parent, fingerprint);
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
  return {
    directory,
    files: content.map((file) => `${file.name}: ${JSON.stringify(file.content)}`),
    verify,
  };
}
