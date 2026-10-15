import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SetupOffers } from "../../../../src/main/agents/setup-offers";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("persists serialized answers privately and tolerates missing or invalid state", async () => {
  const root = await mkdtemp(join(tmpdir(), "foom-setup-offers-"));
  roots.push(root);
  const offers = new SetupOffers();
  await offers.answer("uninitialized");
  expect(offers.answered("uninitialized")).toBe(false);
  await offers.load(root);
  expect(offers.answered("fixture")).toBe(false);
  await Promise.all([offers.answer("fixture"), offers.answer("other")]);
  await rm(join(root, "agent-setup"), { recursive: true });
  await expect(offers.answer("failed")).rejects.toThrow();
  expect(offers.answered("failed")).toBe(false);
  await offers.load(root);
  await offers.answer("fixture");
  await offers.answer("other");
  const loaded = new SetupOffers();
  await loaded.load(root);
  expect(loaded.answered("fixture")).toBe(true);
  expect(loaded.answered("other")).toBe(true);
  for (const invalid of [
    "{",
    "{}",
    '["bad/id"]',
    "[1]",
    JSON.stringify(Array<string>(101).fill("fixture")),
    " ".repeat(16385),
  ]) {
    await writeFile(join(root, "agent-setup/offers.json"), invalid);
    await loaded.load(root);
    expect(loaded.answered("fixture")).toBe(false);
  }
});
