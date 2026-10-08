import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import manifest from "../../../../src/sounds/manifest.json";
import { SOUND_KINDS, DEFAULT_SOUND } from "../../../../src/shared/sounds";
import { SoundLibrary, matchesSoundHeader } from "../../../../src/main/sounds/library";
test("every approved recording has complete provenance, the expected checksum and a packaged notice", async () => {
  const root = join(import.meta.dirname, "../../../../src/sounds");
  const library = new SoundLibrary(root, "/missing");
  const notices = await readFile(join(root, "NOTICES.txt"), "utf8");
  let size = 0;
  const files: string[] = [];
  for (const kind of SOUND_KINDS) {
    const entries = await readdir(join(root, kind));
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries).toContain(DEFAULT_SOUND.choices[kind].file);
    files.push(...entries.map((file) => `${kind}/${file}`));
  }
  expect(manifest.map((entry) => entry.file).sort()).toEqual(files.sort());
  expect(files).toHaveLength(17);
  for (const entry of manifest) {
    expect(entry.author.length).toBeGreaterThan(0);
    expect(entry.source_url).toMatch(/^https:\/\/freesound.org\//);
    expect(entry.license).toBe("CC0-1.0");
    expect(entry.license_url).toBe("https://creativecommons.org/publicdomain/zero/1.0/");
    expect(entry.retrieval_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(entry.source_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.edits.length).toBeGreaterThan(0);
    expect(entry.approved_candidate).not.toBe("W1");
    expect(notices).toContain(entry.source_url);
    expect(notices).toContain(entry.author);
    const bytes = await readFile(join(root, entry.file));
    const kind = SOUND_KINDS.find((kind) => entry.file.startsWith(`${kind}/`));
    const result = await library.read({ kind, source: "builtin", file: entry.file.split("/")[1] });
    if ("error" in result) throw new Error(`${entry.file}: ${result.error}`);
    expect(Object.keys(result)).toEqual(["bytes"]);
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    // Compare the full recording natively instead of walking every byte through
    // the generic deep-equality matcher under coverage on shared CI runners.
    expect(bytes.equals(result.bytes), entry.file).toBe(true);
    size += bytes.length;
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    expect(matchesSoundHeader(entry.file, bytes)).toBe(true);
    const max = entry.file.startsWith("working/")
      ? 30
      : entry.file.startsWith("refusal/")
        ? 0.3
        : 1.5;
    expect(entry.duration).toBeLessThanOrEqual(max);
    expect(entry.duration).toBeGreaterThanOrEqual(entry.file.startsWith("working/") ? 1 : 0);
  }
  expect(size).toBeLessThan(2 * 1024 * 1024);
});
