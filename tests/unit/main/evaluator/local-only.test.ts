import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

test("production contains no model providers or removed module imports", async () => {
  const root = join(import.meta.dirname, "../../../../src");
  const forbidden =
    /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|(?:from\s*|import\s*\(|require\s*\()["'][^"']*(?:model-evaluator|inference-(?:source|probe|keys|input)|probe-(?:stream|response|errors)|shared\/inference)["']/;
  for (const name of await readdir(root, { recursive: true })) {
    if (!/\.(?:tsx?|json)$/.test(name)) continue;
    expect(await readFile(join(root, name), "utf8"), name).not.toMatch(forbidden);
  }
});
