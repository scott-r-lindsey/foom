import { measure, type Engine } from "./measure";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function run(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return (["node:sqlite", "better-sqlite3"] satisfies Engine[]).map((engine) =>
    measure(engine, join(directory, `${engine === "node:sqlite" ? "node" : "better"}.db`), process.env.SPIKE_NATIVE_BINDING));
}
