import { ansiNames, resolveTerminalTheme } from "./terminal-themes.js";
import type { TerminalTheme } from "./terminal-theme";
import type { IParser, ITheme } from "@xterm/xterm";

// xterm's default ANSI palette; application status colors do not redefine shell colors.
const ansi = [
  "2e3436",
  "cc0000",
  "4e9a06",
  "c4a000",
  "3465a4",
  "75507b",
  "06989a",
  "d3d7cf",
  "555753",
  "ef2929",
  "8ae234",
  "fce94f",
  "729fcf",
  "ad7fa8",
  "34e2e2",
  "eeeeec",
].map((color) => `#${color}`);
const hex = (value: number) => value.toString(16).padStart(2, "0");
const levels = [0, 95, 135, 175, 215, 255];
for (const red of levels)
  for (const green of levels)
    for (const blue of levels) ansi.push(`#${hex(red)}${hex(green)}${hex(blue)}`);
for (let index = 0; index < 24; index++) ansi.push(`#${hex(8 + index * 10).repeat(3)}`);

// Match xterm's XParseColor semantics, including truncation for #RGB and rounding for rgb:.
function parseColor(value: string): string | undefined {
  if (/^#(?:[\da-f]{3}){1,4}$/i.test(value)) {
    const width = (value.length - 1) / 3;
    return `#${[0, 1, 2]
      .map((index) => {
        const part = value.slice(1 + index * width, 1 + (index + 1) * width);
        return width === 1 ? `${part}0` : part.slice(0, 2);
      })
      .join("")
      .toLowerCase()}`;
  }
  const match = /^rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/i.exec(value);
  if (!match) return undefined;
  const parts = match.slice(1);
  if (!parts.every((part) => part.length === parts[0]?.length)) return undefined;
  return `#${parts.map((part) => hex(Math.round((Number.parseInt(part, 16) * 255) / (16 ** part.length - 1)))).join("")}`;
}
const osc = (code: number, data: string) => `\x1b]${String(code)};${data}\x1b\\`;
const rgb = (color: string) =>
  `rgb:${[1, 3, 5].map((start) => color.slice(start, start + 2).repeat(2)).join("/")}`;

/** Public parser handlers shared by host and view. Only the host supplies a reply writer. */
export class TerminalColors {
  private defaults: string[] = [];
  private colors: string[] = [];
  private selectionBackground = "";

  constructor(
    parser: IParser,
    dark: boolean | TerminalTheme,
    reply: (data: string) => void,
    changed: () => void = () => {},
  ) {
    this.reset(dark);
    const apply = (index: number, value: string, code: number, prefix = "") => {
      const color = this.colors[index];
      if (!color) return;
      if (value === "?") reply(osc(code, `${prefix}${rgb(color)}`));
      else {
        const parsed = parseColor(value);
        if (parsed) this.colors[index] = parsed;
      }
    };
    parser.registerOscHandler(4, (data) => {
      const parts = data.split(";");
      for (let offset = 0; offset + 1 < parts.length; offset += 2) {
        const index = parts[offset] ?? "";
        if (/^\d+$/.test(index) && Number(index) < 256)
          apply(Number(index), parts[offset + 1] ?? "", 4, `${String(Number(index))};`);
      }
      changed();
      return true;
    });
    for (const code of [10, 11, 12]) {
      parser.registerOscHandler(code, (data) => {
        for (const [offset, value] of data.split(";").entries()) {
          if (code + offset > 12) break;
          apply(256 + code - 10 + offset, value, code + offset);
        }
        changed();
        return true;
      });
      parser.registerOscHandler(code + 100, () => {
        this.restore(256 + code - 10);
        changed();
        return true;
      });
    }
    parser.registerOscHandler(104, (data) => {
      if (!data) this.colors.splice(0, 256, ...this.defaults.slice(0, 256));
      else
        for (const index of data.split(";")) {
          if (/^\d+$/.test(index) && Number(index) < 256) this.restore(Number(index));
        }
      changed();
      return true;
    });
  }

  private restore(index: number): void {
    const color = this.defaults[index];
    if (color) this.colors[index] = color;
  }

  /** A palette change resets OSC overrides, matching xterm's theme replacement. */
  reset(dark: boolean | TerminalTheme): void {
    const theme = typeof dark === "boolean" ? resolveTerminalTheme("follow", dark) : dark;
    this.selectionBackground = theme.selectionBackground;
    this.defaults = [
      ...ansiNames.map((name) => theme[name].toLowerCase()),
      ...ansi.slice(16),
      theme.foreground.toLowerCase(),
      theme.background.toLowerCase(),
      theme.cursor.toLowerCase(),
    ];
    this.colors = [...this.defaults];
  }

  theme(): ITheme {
    const theme: ITheme = {
      selectionBackground: this.selectionBackground,
      extendedAnsi: this.colors.slice(16, 256),
    };
    for (const [index, color] of this.colors.entries()) {
      const name =
        index < 16
          ? ansiNames[index]
          : (["foreground", "background", "cursor"] as const)[index - 256];
      if (name) theme[name] = color;
    }
    return theme;
  }

  /** Serialize colors too: xterm's screen serializer does not include OSC color state. */
  snapshot(): string {
    return (
      osc(
        4,
        this.colors
          .slice(0, 256)
          .flatMap((color, index) => [String(index), color])
          .join(";"),
      ) + osc(10, this.colors.slice(256).join(";"))
    );
  }
}
