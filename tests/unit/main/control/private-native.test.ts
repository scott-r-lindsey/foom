import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ControlRuntime } from "../../../../src/main/control/runtime";
import { verifyPrivate } from "../../../../src/main/control/private-files";
import { afterEach, expect, test, vi } from "vitest";
import {
  atomicPrivate,
  privateDirectory,
  readDiscovery,
} from "../../../../src/main/control/private-files";

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

test.skipIf(process.platform !== "win32")(
  "native Windows ACLs do not autoload inherited PowerShell modules",
  async () => {
    root = await mkdtemp(join(tmpdir(), "foom-native-acl-"));
    const modules = join(root, "modules");
    // Mimic the incompatible module resolution inherited through pwsh -> Node -> powershell.exe.
    // If ACL setup tries any cmdlet from this module, the test must fail.
    const security = join(modules, "Microsoft.PowerShell.Security");
    await mkdir(security, { recursive: true });
    await writeFile(
      join(security, "Microsoft.PowerShell.Security.psd1"),
      "@{ ModuleVersion='1.0'; RootModule='blocked.psm1'; FunctionsToExport=@('Get-Acl','Set-Acl') }",
    );
    await writeFile(
      join(security, "blocked.psm1"),
      "throw 'Inherited security module must not load'",
    );
    vi.stubEnv("PSModulePath", modules);
    const directory = await privateDirectory(root);
    const metadata = {
      version: 1,
      endpoint: "http://127.0.0.1:12345/control/v1",
      instanceId: "native-acl",
    };
    await atomicPrivate(directory, "discovery.json", metadata);
    expect(await readDiscovery(directory)).toEqual(metadata);
    expect(await privateDirectory(root)).toBe(directory);
    const runtime = await ControlRuntime.start(root);
    try {
      const launch = runtime.service.prepare(root, root, "orchestrator");
      launch.bind("terminal");
      const actor = runtime.service.authenticate(launch.env["FOOM_CONTROL_TOKEN"] ?? "");
      const operation = await runtime.service.operations.begin(actor, "stop", "key", "{}");
      await runtime.service.operations.finish(
        actor,
        operation.operationId,
        "succeeded",
        "completed",
      );
      await verifyPrivate(join(directory, `operation-${operation.operationId}.json`), false);
      await verifyPrivate(join(directory, "actions-0.jsonl"), false);
    } finally {
      await runtime.close();
    }
  },
  30000,
);
