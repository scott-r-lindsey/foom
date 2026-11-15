import { createHash } from "node:crypto";
import { setupCatalog } from "../shared/repository-setup-catalog";
export const setupDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const setupCatalogDigest = setupDigest(setupCatalog);
