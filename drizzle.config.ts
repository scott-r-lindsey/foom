import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/main/data/sqlite/schema.ts",
  out: "./src/main/data/sqlite/migrations",
});
