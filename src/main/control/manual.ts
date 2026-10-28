import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ControlError, exact, object } from "../../shared/control-validation";

/** UTF-16 code units; JSON escaping still leaves the complete response below 64 KiB. */
export const MANUAL_PAGE_SIZE = 4096;
interface Section {
  id: string;
  heading: string;
  text: string;
}

export class ManualSectionError extends ControlError {
  constructor(readonly validIds: readonly string[]) {
    super("invalid_request");
  }
}

/** No repository, session, caller-selected path, network or write capability. */
export class Manual {
  constructor(private readonly sections: readonly Section[]) {}

  read(input: unknown) {
    const params = object(input);
    exact(params, ["section", "page"]);
    const id = params["section"];
    const page = params["page"] === undefined ? 0 : params["page"];
    if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 0)
      throw new ControlError("invalid_request");
    if (id === undefined) {
      if (params["page"] !== undefined) throw new ControlError("invalid_request");
      return {
        sections: this.sections.map((section) => ({
          id: section.id,
          title: section.heading,
          summary: section.text.slice(section.heading.length).trim().slice(0, 160),
        })),
      };
    }
    if (typeof id !== "string" || id.length < 1 || id.length > 200)
      throw new ControlError("invalid_request");
    const section = this.sections.find((entry) => entry.id === id);
    if (!section) throw new ManualSectionError(this.sections.map((entry) => entry.id));
    // Fixed code-point pages preserve non-BMP characters at page boundaries.
    const characters = Array.from(section.text);
    const start = page * (MANUAL_PAGE_SIZE / 2);
    if (start >= characters.length && page !== 0) throw new ControlError("invalid_request");
    const end = start + MANUAL_PAGE_SIZE / 2;
    return {
      id: section.id,
      title: section.heading,
      text: characters.slice(start, end).join(""),
      page,
      ...(end < characters.length ? { nextPage: page + 1 } : {}),
    };
  }
}

/** Electron's fs reads this fixed native path through ASAR on all platforms. */
export function bundledManual(): Manual {
  const index: unknown = JSON.parse(
    readFileSync(join(__dirname, "../../manual/sections.json"), "utf8"),
  );
  if (!Array.isArray(index) || index.length > 100) throw new ControlError("unavailable");
  const sections = index.map((value: unknown) => {
    const section = object(value);
    const id = section["id"];
    const heading = section["heading"];
    const text = section["text"];
    if (
      typeof id !== "string" ||
      id.length > 200 ||
      typeof heading !== "string" ||
      heading.length > 200 ||
      typeof text !== "string" ||
      text.length > 1_048_576
    )
      throw new ControlError("unavailable");
    return { id, heading, text };
  });
  return new Manual(sections);
}
