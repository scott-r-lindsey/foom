import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Periods = Partial<Record<"d" | "w" | "m", string>>;

function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

/** Main-only high-water dates, shared across channels; no identity or counts. */
export class UpdateActivity {
  private dates: Periods | undefined;
  private pending = Promise.resolve();

  constructor(private readonly userData: string) {}

  flags(now = new Date()): Promise<string> {
    const result = this.pending.then(() => this.nextFlags(now));
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async nextFlags(now: Date): Promise<string> {
    const file = join(this.userData, "update-activity.json");
    if (!this.dates) {
      this.dates = {};
      try {
        const value: unknown = JSON.parse(await readFile(file, "utf8"));
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          for (const key of ["d", "w", "m"] as const) {
            const date: unknown = Reflect.get(value, key);
            if (
              validDate(date) &&
              (key !== "w" || new Date(date).getUTCDay() === 1) &&
              (key !== "m" || date.endsWith("-01"))
            )
              this.dates[key] = date;
          }
        }
      } catch {
        // Missing or invalid profile values mean never sent.
      }
    }
    const day = now.toISOString().slice(0, 10);
    const monday = new Date(`${day}T00:00:00Z`);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const periods = { d: day, w: monday.toISOString().slice(0, 10), m: day.slice(0, 8) + "01" };
    const next = { ...this.dates };
    const flags = new URLSearchParams();
    for (const key of ["d", "w", "m"] as const) {
      if (!next[key] || periods[key] > next[key]) {
        flags.set(key, "1");
        next[key] = periods[key];
      }
    }
    if (flags.size) {
      // Reserve before sending: a failed response or backwards clock must not
      // count the same period again, including after restarting the app.
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 });
        await rename(temporary, file);
        this.dates = next;
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return flags.size ? `?${flags.toString()}` : "";
  }
}
