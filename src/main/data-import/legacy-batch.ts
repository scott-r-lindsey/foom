import { sql } from "drizzle-orm";
import type { DataTransaction } from "./commands";
import { RelationshipError } from "./commands";
import { quarantine } from "../data/sqlite/schema";

/** Input validation is separated from SQL failures: I/O and interruption abort the
 * entire group, while rejected rows retain only a fixed source and position. */
export class LegacyBatch {
  accepted = 0;
  quarantined = 0;
  constructor(private readonly db: DataTransaction) {}
  reject(
    source: string,
    position: number,
    reason: "invalid" | "relationship" | "conflict" = "invalid",
  ): void {
    this.db.insert(quarantine).values({ source, position, reason }).run();
    this.quarantined++;
  }
  row<T>(source: string, position: number, validate: () => T, save: (value: T) => void): void {
    let value: T;
    try {
      value = validate();
    } catch (error) {
      this.reject(
        source,
        position,
        error instanceof RelationshipError ? "relationship" : "invalid",
      );
      return;
    }
    this.db.run(sql`SAVEPOINT legacy_row`);
    try {
      save(value);
      this.db.run(sql`RELEASE legacy_row`);
      this.accepted++;
    } catch (error) {
      this.db.run(sql`ROLLBACK TO legacy_row`);
      this.db.run(sql`RELEASE legacy_row`);
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      if (cause instanceof RelationshipError) this.reject(source, position, "relationship");
      else if (
        cause instanceof Error &&
        "errcode" in cause &&
        typeof cause.errcode === "number" &&
        (cause.errcode & 255) === 19
      )
        this.reject(source, position, cause.errcode === 787 ? "relationship" : "conflict");
      else throw error;
    }
  }
  report() {
    return { accepted: this.accepted, quarantined: this.quarantined };
  }
}
