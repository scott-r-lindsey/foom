import { createHash } from "node:crypto";
import { setupCatalog } from "../shared/repository-setup-catalog";
export const setupDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const setupCatalogDigest = setupDigest(setupCatalog);

/** Exact historical catalog identity; only its persisted data schema may be read. */
export const setupCatalogV1Digest =
  "2ab1b358e9b2ec89c223e5cf93be371bb995ecb028e1637eff2872a3e13136ed";
