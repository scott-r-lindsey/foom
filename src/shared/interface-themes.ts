import type {
  InterfaceColor,
  InterfaceTheme,
  InterfaceThemeChoice,
  InterfaceThemeId,
} from "./interface-theme";
import { colorDistance, contrast, hueSaturation } from "./theme-colors";
export const interfaceColorNames: readonly InterfaceColor[] = [
  "bg",
  "surface",
  "line",
  "ink",
  "muted",
  "accent",
  "accent-deep",
  "attention",
  "attention-ink",
  "done",
  "done-ink",
  "failed",
  "failed-ink",
  "hole",
  "space-ink",
  "badge-label-fill",
  "badge-label-ink",
  "badge-fill",
  "badge-ink",
];
const light: InterfaceTheme["colors"] = {
  bg: "#f3f0fa",
  surface: "#e9e4f5",
  line: "#ddd6ee",
  ink: "#14101f",
  muted: "#625a7a",
  accent: "#5b2bd9",
  "accent-deep": "#3b1a99",
  attention: "#d98200",
  "attention-ink": "#8c5000",
  done: "#13804a",
  "done-ink": "#0e6b3c",
  failed: "#d6166e",
  "failed-ink": "#b0105a",
  hole: "#06050b",
  "space-ink": "#f4efff",
  "badge-label-fill": "#4a4263",
  "badge-label-ink": "#f4efff",
  "badge-fill": "#d6cfe9",
  "badge-ink": "#14101f",
};
const dark: InterfaceTheme["colors"] = {
  bg: "#05040a",
  surface: "#0d0a17",
  line: "#251d3f",
  ink: "#f4efff",
  muted: "#9d93bd",
  accent: "#9b6bff",
  "accent-deep": "#7a3cff",
  attention: "#ffb23e",
  "attention-ink": "#ffb23e",
  done: "#6fe0a3",
  "done-ink": "#6fe0a3",
  failed: "#ff2e88",
  "failed-ink": "#ff2e88",
  hole: "#06050b",
  "space-ink": "#f4efff",
  "badge-label-fill": "#3a3060",
  "badge-label-ink": "#f4efff",
  "badge-fill": "#1c1632",
  "badge-ink": "#f4efff",
};
export const interfaceThemes: Readonly<Record<InterfaceThemeId, InterfaceTheme>> = {
  "eclipse-light": { version: 1, name: "Eclipse Light", base: "light", colors: light },
  "eclipse-dark": { version: 1, name: "Eclipse Dark", base: "dark", colors: dark },
  "high-contrast": {
    version: 1,
    name: "High Contrast",
    base: "dark",
    colors: {
      ...dark,
      bg: "#000000",
      surface: "#080808",
      line: "#8c8996",
      ink: "#ffffff",
      muted: "#c9c4d9",
      accent: "#b9a0ff",
      "accent-deep": "#9b6bff",
      attention: "#ffc466",
      "attention-ink": "#ffc466",
      done: "#86f2b4",
      "done-ink": "#86f2b4",
      failed: "#ff80b8",
      "failed-ink": "#ff80b8",
      "badge-label-fill": "#272232",
      "badge-fill": "#17141e",
      "badge-ink": "#ffffff",
      "badge-label-ink": "#ffffff",
    },
  },
  "deep-field": {
    version: 1,
    name: "Deep Field",
    base: "dark",
    colors: {
      ...dark,
      bg: "#080f1e",
      surface: "#111b2f",
      line: "#344260",
      ink: "#edf1ff",
      muted: "#a5b0cc",
      accent: "#b39aff",
      "accent-deep": "#9569f5",
      failed: "#ff65a8",
      "failed-ink": "#ff65a8",
      "badge-label-fill": "#313b58",
      "badge-fill": "#202b43",
      "badge-ink": "#edf1ff",
      "badge-label-ink": "#edf1ff",
    },
  },
  graphite: {
    version: 1,
    name: "Graphite",
    base: "dark",
    colors: {
      ...dark,
      bg: "#18181b",
      surface: "#242428",
      line: "#484850",
      ink: "#f1f1f5",
      muted: "#b0afb8",
      accent: "#bca5ff",
      "accent-deep": "#9165f0",
      failed: "#ff65a8",
      "failed-ink": "#ff65a8",
      "badge-label-fill": "#45454f",
      "badge-label-ink": "#f1f1f5",
      "badge-fill": "#303035",
      "badge-ink": "#f1f1f5",
    },
  },
  "midnight-indigo": {
    version: 1,
    name: "Midnight Indigo",
    base: "dark",
    colors: {
      ...dark,
      bg: "#101027",
      surface: "#1b1b39",
      line: "#41416a",
      ink: "#f1efff",
      muted: "#b6b3d7",
      accent: "#b69bff",
      "accent-deep": "#9265ef",
      failed: "#ff65a8",
      "failed-ink": "#ff65a8",
      "badge-label-fill": "#3b3b61",
      "badge-label-ink": "#f1efff",
      "badge-fill": "#292947",
      "badge-ink": "#f1efff",
    },
  },
  moonlight: {
    version: 1,
    name: "Moonlight",
    base: "light",
    colors: {
      ...light,
      bg: "#f5f7fc",
      surface: "#e9edf5",
      line: "#ccd2df",
      ink: "#182133",
      muted: "#536079",
      accent: "#5836c2",
      "accent-deep": "#3b218e",
      "badge-label-fill": "#414d65",
      "badge-fill": "#d9dfed",
      "badge-ink": "#182133",
      "badge-label-ink": "#f5f7fc",
    },
  },
};
export function isInterfaceThemeId(value: string): value is InterfaceThemeId {
  return Object.hasOwn(interfaceThemes, value);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
function colors(value: unknown): value is InterfaceTheme["colors"] {
  return (
    record(value) &&
    exact(value, interfaceColorNames) &&
    interfaceColorNames.every(
      (key) => typeof value[key] === "string" && /^#[0-9a-f]{6}$/i.test(value[key]),
    )
  );
}
/** The same brand/accessibility gate is used for built-ins and untrusted user data. */
export function validateInterfaceColors(palette: InterfaceTheme["colors"]): void {
  const fail = () => {
    throw new Error("Theme must preserve brand colors and readable contrast");
  };
  if (palette.hole.toLowerCase() !== "#06050b") fail();
  for (const key of [
    "attention",
    "attention-ink",
    "failed",
    "failed-ink",
    "accent",
    "accent-deep",
  ] as const) {
    const { hue, saturation } = hueSaturation(palette[key]);
    const [min, max] = key.startsWith("attention")
      ? [25, 50]
      : key.startsWith("failed")
        ? [315, 345]
        : [245, 280];
    if (hue < min || hue > max || saturation < 0.45) fail();
  }
  for (const key of interfaceColorNames) {
    if (key.startsWith("attention") || key.startsWith("failed")) continue;
    const { hue, saturation } = hueSaturation(palette[key]);
    if (saturation > 0.2 && ((hue >= 20 && hue <= 55) || (hue >= 310 && hue <= 350))) fail();
  }
  for (const [a, b] of [
    ["attention", "failed"],
    ["attention", "accent"],
    ["failed", "accent"],
    ["attention-ink", "failed-ink"],
    ["attention-ink", "accent"],
    ["failed-ink", "accent"],
  ] as const)
    if (colorDistance(palette[a], palette[b]) < 40) fail();
  for (const background of ["bg", "surface"] as const)
    for (const foreground of [
      "ink",
      "muted",
      "accent",
      "attention-ink",
      "done-ink",
      "failed-ink",
    ] as const)
      if (contrast(palette[foreground], palette[background]) < 4.5) fail();
  for (const [foreground, background] of [
    ["badge-ink", "badge-fill"],
    ["badge-label-ink", "badge-label-fill"],
    ["space-ink", "hole"],
  ] as const)
    if (contrast(palette[foreground], palette[background]) < 4.5) fail();
}
export function parseInterfaceTheme(value: unknown): InterfaceThemeChoice {
  if (typeof value === "string" && (value === "follow" || isInterfaceThemeId(value))) return value;
  if (
    !record(value) ||
    !exact(value, ["version", "name", "base", "colors"]) ||
    value["version"] !== 1 ||
    typeof value["name"] !== "string" ||
    !/^[\p{L}\p{N} ._-]{1,40}$/u.test(value["name"]) ||
    (value["base"] !== "light" && value["base"] !== "dark") ||
    !colors(value["colors"])
  )
    throw new Error("Invalid interface theme");
  validateInterfaceColors(value["colors"]);
  const dark = contrast(value["colors"].bg, "#ffffff") > contrast(value["colors"].bg, "#000000");
  if (dark !== (value["base"] === "dark")) throw new Error("Theme base must match its background");
  return { version: 1, name: value["name"], base: value["base"], colors: { ...value["colors"] } };
}
export function resolveInterfaceTheme(choice: InterfaceThemeChoice, dark: boolean): InterfaceTheme {
  return typeof choice !== "string"
    ? choice
    : interfaceThemes[choice === "follow" ? (dark ? "eclipse-dark" : "eclipse-light") : choice];
}
export function interfaceThemeSource(
  choice: InterfaceThemeChoice,
  mode: "system" | "light" | "dark",
): "system" | "light" | "dark" {
  return choice === "follow" ? mode : resolveInterfaceTheme(choice, false).base;
}
