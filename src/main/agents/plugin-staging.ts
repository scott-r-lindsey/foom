import { createHash } from "node:crypto";
import { join } from "node:path";
import { open, readdir } from "node:fs/promises";
import type { AgentManifestV2 } from "../../shared/agent-manifest-v2";
import { dataContainer } from "../../shared/agent-manifest-container";
import { createPrivateFile, privateDirectory, verifyPrivate } from "../control/private-files";
import { selected, type Facts } from "./providers/v2-values";

/** Immutable, content-addressed staging under Foom's profile, never the agent's home. */
export async function stagePlugin(model: AgentManifestV2, root: string, facts: Facts) {
  const files = model.files.filter((file) => file.scope === "plugin" && selected(file.when, facts));
  const content = files.map((file) => {
    // Hook ABI substitutions are supplied by the hook engine, never manifest-authored scripts.
    if (/\{observer/u.test(file.content)) throw new Error("Plugin observer staging is unavailable");
    dataContainer(file.content, file.format, "$.files", true);
    return { name: file.name, content: file.content };
  });
  if (!content.some((file) => file.name === "plugin.json"))
    throw new Error("Missing staged plugin manifest");
  const fingerprint = createHash("sha256").update(JSON.stringify(content)).digest("hex");
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
      await verifyPrivate(target, false);
      const handle = await open(target, "r");
      try {
        const bytes = Buffer.alloc(Buffer.byteLength(file.content) + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytes.subarray(0, bytesRead).toString("utf8") !== file.content)
          throw new Error("Staged plugin changed");
      } finally {
        await handle.close();
      }
      await verifyPrivate(target, false);
    }
  };
  await verify();
  return {
    directory,
    files: content.map((file) => `${file.name}: ${JSON.stringify(file.content)}`),
    verify,
  };
}
