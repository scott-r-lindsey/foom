import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ProbeNotices } from "../../../../src/main/agents/probe-notices";
test("persists agent IDs only, serializes simultaneous first notices, and recovers damaged data", async () => {
  const root = await mkdtemp(join(tmpdir(), "foom-probe-notices-"));
  try {
    const notices = new ProbeNotices(root);
    expect(await Promise.all([notices.first("copilot"), notices.first("copilot")])).toEqual([
      true,
      false,
    ]);
    expect(await new ProbeNotices(root).first("copilot")).toBe(false);
    const file = join(root, "probe-notices", "seen.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(["copilot"]);
    for (const invalid of [
      "broken",
      "{}",
      '["bad/id"]',
      JSON.stringify(Array<string>(1001).fill("codex")),
    ]) {
      await writeFile(file, invalid, { mode: 0o600 });
      expect(await notices.first("claude")).toBe(true);
    }
    await writeFile(
      file,
      JSON.stringify(Array.from({ length: 1000 }, (_, i) => `agent${String(i)}`)),
      {
        mode: 0o600,
      },
    );
    expect(await notices.first("codex")).toBe(true);
    expect(await notices.first("bad/id")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed notice write remains retryable", async () => {
  const { mkdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "foom-probe-notices-retry-"));
  const blocked = join(root, "blocked");
  try {
    await writeFile(blocked, "not a directory");
    const notices = new ProbeNotices(blocked);
    await expect(notices.first("codex")).rejects.toThrow();
    await rm(blocked);
    await mkdir(blocked);
    expect(await notices.first("codex")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
