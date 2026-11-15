import type { InterfaceTheme, InterfaceGradient, InterfaceAreaTheme } from "./interface-theme";
import type { ThemeDiagnostic, ThemeReason } from "./theme-file";
import { interfaceColorNames, interfaceHighlightNames } from "./interface-themes";
import { colorDistance, contrast, hueSaturation, interpolatedContrast } from "./theme-colors";
import { ThemeValidationError, themeColor, themeKeys, themeRecord } from "./theme-validation";

export const interfaceAreas = [
  "sidebar",
  "tiles",
  "panels",
  "dialogs",
  "menus",
  "titlebar",
  "tile-headers",
  "board",
  "badges",
  "wordmark",
  "dialog-headers",
] as const;
export const interfaceFontStacks = {
  geist: '"Geist", sans-serif',
  "geist-mono": '"Geist Mono", monospace',
  system: "system-ui, sans-serif",
  "system-mono": "ui-monospace, monospace",
} as const;
const interfaceFamilies = ["geist", "geist-mono", "system", "system-mono"] as const;
const inkNames = [
  "ink",
  "muted",
  "accent",
  "attention-ink",
  "done-ink",
  "failed-ink",
  "highlight",
] as const;
const gradientAreas = new Set(["sidebar", "board", "titlebar", "dialog-headers"]);

function bounded(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new ThemeValidationError(path, "invalid-value");
  return value;
}
function gradient(value: unknown, path: string): InterfaceGradient {
  const record = themeRecord(value, path);
  themeKeys(record, ["angle", "stops"], path);
  const angle = bounded(record["angle"], `${path}.angle`, 0, 359);
  const stops = record["stops"];
  if (!Array.isArray(stops) || stops.length < 2 || stops.length > 4)
    throw new ThemeValidationError(`${path}.stops`, "invalid-value");
  let previous = -1;
  const result: [string, number][] = [];
  for (const [index, stop] of stops.entries()) {
    const stopPath = `${path}.stops[${String(index)}]`;
    if (!Array.isArray(stop) || stop.length !== 2)
      throw new ThemeValidationError(stopPath, "invalid-value");
    const color = themeColor(stop[0], `${stopPath}[0]`);
    const percent = bounded(stop[1], `${stopPath}[1]`, 0, 100);
    if (percent <= previous) throw new ThemeValidationError(`${stopPath}[1]`, "invalid-value");
    previous = percent;
    result.push([color, percent]);
  }
  return { angle, stops: result };
}
function areaPalette(value: unknown, path: string, area: string): InterfaceAreaTheme {
  const record = themeRecord(value, path);
  themeKeys(record, [], path, [...colorNames, "gradient", "scrollbar"]);
  const colors = Object.fromEntries(
    Object.entries(record).filter(([key]) => colorNames.some((name) => name === key)),
  );
  const result: InterfaceAreaTheme = { ...palette(colors, path, true) };
  if (Object.hasOwn(record, "scrollbar"))
    result.scrollbar = themeColor(record["scrollbar"], `${path}.scrollbar`);
  if (Object.hasOwn(record, "gradient")) {
    if (!gradientAreas.has(area))
      throw new ThemeValidationError(`${path}.gradient`, "gradient-not-allowed");
    // Explicit solid fallback remains required when a gradient is supplied.
    if (!Object.hasOwn(record, "bg")) throw new ThemeValidationError(`${path}.bg`, "missing-key");
    result.gradient = gradient(record["gradient"], `${path}.gradient`);
  }
  return result;
}
export const interfaceStates = ["selected", "hover", "focus", "scrollbar"] as const;
export const interfaceShapeBounds = {
  radius: 12,
  "panel-radius": 16,
  border: 2,
  shadow: 1,
} as const;
const colorNames = [...interfaceColorNames, ...interfaceHighlightNames];

function palette(value: unknown, path: string, partial = false): Partial<InterfaceTheme["colors"]> {
  const record = themeRecord(value, path);
  themeKeys(record, partial ? [] : interfaceColorNames, path, colorNames);
  const result: { -readonly [K in keyof InterfaceTheme["colors"]]?: string } = {};
  for (const key of colorNames)
    if (Object.hasOwn(record, key)) result[key] = themeColor(record[key], `${path}.${key}`);
  if (!partial)
    for (const key of interfaceHighlightNames)
      if (
        Object.hasOwn(result, key) &&
        !Object.hasOwn(result, key === "highlight" ? "highlight-deep" : "highlight")
      )
        throw new ThemeValidationError(
          `${path}.${key === "highlight" ? "highlight-deep" : "highlight"}`,
          "missing-key",
        );
  return result;
}

/** Colors within ΔE 40 of attention, as `role~other`. The paired attention ink shares its hue. */
function attentionPartners(colors: InterfaceTheme["colors"]): string[] {
  const partners: string[] = [];
  for (const other of colorNames) {
    const color = colors[other];
    if (
      !other.startsWith("attention") &&
      color !== undefined &&
      colorDistance(colors.attention, color) < 40
    )
      partners.push(`attention~${other}`);
  }
  for (const other of ["failed-ink", "accent"] as const)
    if (colorDistance(colors["attention-ink"], colors[other]) < 40)
      partners.push(`attention-ink~${other}`);
  return partners;
}

/**
 * Every pair that makes needs-you hard to tell apart, globally and per area. An area
 * lists only pairs the global palette doesn't already have, so adding an area that
 * inherits an approved pair is not new. The approval hold compares these sets.
 */
export function attentionConflicts(theme: InterfaceTheme): string[] {
  const global = attentionPartners(theme.colors);
  const conflicts = global.map((partner) => `colors:${partner}`);
  for (const area of interfaceAreas) {
    const colors = theme.areas?.[area];
    if (!colors) continue;
    const effective = { ...theme.colors, ...colors };
    for (const partner of attentionPartners(effective))
      if (!global.includes(partner)) conflicts.push(`${area}:${partner}`);
    for (const [index, [stop]] of (colors.gradient?.stops ?? []).entries())
      if (colorDistance(effective.attention, stop) < 40)
        conflicts.push(`${area}:gradient[${String(index)}]~attention`);
    if (colors.scrollbar && colorDistance(effective.attention, colors.scrollbar) < 40)
      conflicts.push(`${area}:attention~scrollbar`);
  }
  return conflicts;
}

/** User themes retain the accessibility gate, but report brand policy as fixed warnings. */
export function userThemeWarnings(theme: InterfaceTheme): ThemeDiagnostic[] {
  const warnings: ThemeDiagnostic[] = [];
  const warn = (path: string, reason: ThemeReason) => {
    warnings.push({ file: "", path, reason, severity: "warning" });
  };
  const check = (colors: InterfaceTheme["colors"], path: string) => {
    for (const foreground of inkNames)
      for (const background of ["bg", "surface"] as const)
        if (contrast(colors[foreground] ?? colors.accent, colors[background]) < 4.5)
          throw new ThemeValidationError(`${path}.${foreground}`, "contrast");
    for (const [foreground, background] of [
      ["badge-ink", "badge-fill"],
      ["badge-label-ink", "badge-label-fill"],
      ["space-ink", "hole"],
    ] as const)
      if (contrast(colors[foreground], colors[background]) < 4.5)
        throw new ThemeValidationError(`${path}.${foreground}`, "contrast");
    if (colors.hole.toLowerCase() !== "#06050b") warn(`${path}.hole`, "hole-color");
    for (const key of colorNames) {
      const color = colors[key];
      if (color === undefined) continue;
      const { hue, saturation } = hueSaturation(color);
      const attention = key.startsWith("attention");
      const failed = key.startsWith("failed");
      if (attention || failed) {
        const [min, max] = attention ? [25, 50] : [315, 345];
        if (hue < min || hue > max || saturation < 0.45) warn(`${path}.${key}`, "reserved-color");
      } else if (saturation > 0.2 && ((hue >= 20 && hue <= 55) || (hue >= 310 && hue <= 350)))
        warn(`${path}.${key}`, "reserved-color");
    }
    if (colors.highlight !== undefined && colorDistance(colors.accent, colors.highlight) < 40)
      warn(`${path}.accent`, "color-distance");
    for (const partner of attentionPartners(colors))
      warn(`${path}.${partner.split("~")[0] ?? "attention"}`, "attention-distinctness");
    for (const [a, b] of [
      ["failed", "accent"],
      ["failed-ink", "accent"],
      ["failed", "highlight"],
      ["failed", "done"],
      ["accent", "done"],
    ] as const)
      if (colorDistance(colors[a], colors[b] ?? colors.accent) < 40)
        warn(`${path}.${a}`, "color-distance");
  };
  check(theme.colors, "$.colors");
  for (const area of interfaceAreas) {
    const override = theme.areas?.[area];
    if (!override) continue;
    const colors = { ...theme.colors, ...override };
    const path = `$.areas.${area}`;
    check(colors, path);
    if (override.scrollbar && colorDistance(colors.attention, override.scrollbar) < 40)
      warn(`${path}.scrollbar`, "attention-distinctness");
    const stops = override.gradient?.stops ?? [];
    for (const [index, [stop]] of stops.entries()) {
      const stopPath = `${path}.gradient.stops[${String(index)}]`;
      if (colorDistance(colors.attention, stop) < 40) warn(stopPath, "attention-distinctness");
      for (const ink of inkNames) {
        const foreground = colors[ink] ?? colors.accent;
        if (contrast(stop, foreground) < 4.5) throw new ThemeValidationError(stopPath, "contrast");
        const next = stops[index + 1];
        if (next)
          for (let sample = 0; sample < 256; sample++)
            if (interpolatedContrast(stop, next[0], foreground, sample / 255) < 4.5)
              throw new ThemeValidationError(`${path}.gradient`, "contrast");
      }
    }
  }
  const dark = contrast(theme.colors.bg, "#ffffff") > contrast(theme.colors.bg, "#000000");
  if (dark !== (theme.base === "dark")) warn("$.base", "base-luminance");
  return warnings.filter(
    (warning, index) =>
      warnings.findIndex(
        (other) => other.path === warning.path && other.reason === warning.reason,
      ) === index,
  );
}

export function parseUserInterfaceTheme(value: Record<string, unknown>): InterfaceTheme {
  const version = Object.hasOwn(value, "version") ? value["version"] : 1;
  if (version !== 1 && version !== 2) throw new ThemeValidationError("$.version", "invalid-value");
  const base = value["base"];
  if (base !== "dark" && base !== "light")
    throw new ThemeValidationError("$.base", "invalid-value");
  const name = value["name"];
  if (typeof name !== "string" || !/^[\p{L}\p{N} ._-]{1,40}$/u.test(name) || !name.trim())
    throw new ThemeValidationError("$.name", "invalid-value");
  const colors = palette(value["colors"], "$.colors");
  const theme: InterfaceTheme = {
    version,
    name,
    base,
    colors: {
      ...colors,
      bg: themeColor(colors["bg"], "$.colors.bg"),
      surface: themeColor(colors["surface"], "$.colors.surface"),
      line: themeColor(colors["line"], "$.colors.line"),
      ink: themeColor(colors["ink"], "$.colors.ink"),
      muted: themeColor(colors["muted"], "$.colors.muted"),
      accent: themeColor(colors["accent"], "$.colors.accent"),
      "accent-deep": themeColor(colors["accent-deep"], "$.colors.accent-deep"),
      attention: themeColor(colors["attention"], "$.colors.attention"),
      "attention-ink": themeColor(colors["attention-ink"], "$.colors.attention-ink"),
      done: themeColor(colors["done"], "$.colors.done"),
      "done-ink": themeColor(colors["done-ink"], "$.colors.done-ink"),
      failed: themeColor(colors["failed"], "$.colors.failed"),
      "failed-ink": themeColor(colors["failed-ink"], "$.colors.failed-ink"),
      hole: themeColor(colors["hole"], "$.colors.hole"),
      "space-ink": themeColor(colors["space-ink"], "$.colors.space-ink"),
      "badge-label-fill": themeColor(colors["badge-label-fill"], "$.colors.badge-label-fill"),
      "badge-label-ink": themeColor(colors["badge-label-ink"], "$.colors.badge-label-ink"),
      "badge-fill": themeColor(colors["badge-fill"], "$.colors.badge-fill"),
      "badge-ink": themeColor(colors["badge-ink"], "$.colors.badge-ink"),
    },
  };
  if (Object.hasOwn(value, "areas")) {
    const areas = themeRecord(value["areas"], "$.areas");
    themeKeys(areas, [], "$.areas", interfaceAreas);
    theme.areas = {};
    for (const area of interfaceAreas)
      if (Object.hasOwn(areas, area))
        theme.areas[area] = areaPalette(areas[area], `$.areas.${area}`, area);
  }
  if (Object.hasOwn(value, "type")) {
    const type = themeRecord(value["type"], "$.type");
    themeKeys(type, [], "$.type", ["family", "scale", "weight", "strong-weight"]);
    theme.type = {};
    if (Object.hasOwn(type, "family")) {
      const family = interfaceFamilies.find((entry) => entry === type["family"]);
      if (!family) throw new ThemeValidationError("$.type.family", "invalid-value");
      theme.type.family = family;
    }
    for (const [key, min, max] of [
      ["scale", 0.85, 1.25],
      ["weight", 400, 600],
      ["strong-weight", 500, 800],
    ] as const)
      if (Object.hasOwn(type, key)) theme.type[key] = bounded(type[key], `$.type.${key}`, min, max);
  }
  if (Object.hasOwn(value, "states")) {
    const states = themeRecord(value["states"], "$.states");
    themeKeys(states, [], "$.states", interfaceStates);
    theme.states = {};
    for (const key of interfaceStates)
      if (Object.hasOwn(states, key))
        theme.states[key] = themeColor(states[key], `$.states.${key}`);
  }
  if (Object.hasOwn(value, "shape")) {
    const shape = themeRecord(value["shape"], "$.shape");
    themeKeys(shape, [], "$.shape", Object.keys(interfaceShapeBounds));
    theme.shape = {};
    for (const key of ["radius", "panel-radius", "border", "shadow"] as const) {
      if (!Object.hasOwn(shape, key)) continue;
      const number = shape[key];
      if (
        typeof number !== "number" ||
        !Number.isFinite(number) ||
        number < 0 ||
        number > interfaceShapeBounds[key]
      )
        throw new ThemeValidationError(`$.shape.${key}`, "invalid-value");
      theme.shape[key] = number;
    }
  }
  return theme;
}
