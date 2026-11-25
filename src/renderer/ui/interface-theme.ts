import { themeBitmapSlots } from "../../shared/theme-bitmaps";
import type { InterfaceTheme, InterfaceGradient } from "../../shared/interface-theme";
import {
  interfaceAreas,
  interfaceStates,
  interfaceFontStacks,
} from "../../shared/user-interface-theme";
import type { ThemeCatalog } from "../../shared/theme-file";
import {
  interfaceColorNames,
  interfaceHighlightNames,
  resolveInterfaceTheme,
} from "../../shared/interface-themes";
import type { Settings } from "../../shared/setup";
import type { SetupSource } from "../preflight/setup-source.d";

export function interfaceGradientCss(gradient: InterfaceGradient | undefined): string | undefined {
  return gradient
    ? `linear-gradient(${String(gradient.angle)}deg in srgb, ${gradient.stops.map(([color, percent]) => `${color} ${String(percent)}%`).join(", ")})`
    : undefined;
}
export function applyInterfaceTypography(theme: InterfaceTheme, target: HTMLElement): void {
  const family = theme.type?.family;
  for (const name of ["interface", "mono"]) {
    if (family) target.style.setProperty(`--font-${name}`, interfaceFontStacks[family]);
    else target.style.removeProperty(`--font-${name}`);
  }
  for (const key of ["scale", "weight", "strong-weight"] as const) {
    const value = theme.type?.[key];
    if (value === undefined) target.style.removeProperty(`--type-${key}`);
    else target.style.setProperty(`--type-${key}`, String(value));
  }
}

/** One subscription updates tokens without coupling high-frequency board data to React. */
export function attachInterfaceTheme(
  source: Pick<SetupSource, "state" | "subscribe">,
  target = document.documentElement,
  media = matchMedia("(prefers-color-scheme: dark)"),
) {
  let settings: Pick<Settings, "interfaceTheme" | "panelColor"> = {
    interfaceTheme: "follow",
    panelColor: "vivid",
  };
  let catalog: ThemeCatalog | undefined;
  let disposed = false;
  let revision = 0;
  const properties = new Set<string>();
  const property = (key: string, value: string | undefined) => {
    properties.add(key);
    if (value === undefined) target.style.removeProperty(key);
    else target.style.setProperty(key, value);
  };
  const apply = () => {
    const dark = media.matches;
    const theme = resolveInterfaceTheme(settings.interfaceTheme, dark, catalog);
    for (const key of interfaceColorNames) target.style.setProperty(`--${key}`, theme.colors[key]);
    target.style.setProperty("--highlight", theme.colors.highlight ?? theme.colors.accent);
    target.style.setProperty(
      "--highlight-deep",
      theme.colors["highlight-deep"] ?? theme.colors["accent-deep"],
    );
    for (const key of [...interfaceColorNames, ...interfaceHighlightNames]) {
      const value =
        theme.colors[key] ?? theme.colors[key === "highlight" ? "accent" : "accent-deep"];
      property(`--theme-${key}`, value);
      for (const area of interfaceAreas) {
        const colors = { ...theme.colors, ...theme.areas?.[area] };
        property(
          `--theme-${area}-${key}`,
          colors[key] ?? colors[key === "highlight" ? "accent" : "accent-deep"],
        );
      }
    }
    for (const area of interfaceAreas) {
      const override = theme.areas?.[area];
      property(`--theme-${area}-scrollbar`, override?.scrollbar ?? theme.states?.scrollbar);
      property(`--theme-${area}-gradient`, interfaceGradientCss(override?.gradient));
    }
    target.dataset["themeAreas"] = Object.keys(theme.areas ?? {}).join(" ");
    target.dataset["themeGradients"] = interfaceAreas
      .filter((area) => theme.areas?.[area]?.gradient)
      .join(" ");
    const activeBitmaps = catalog?.activeBitmaps;
    const slots =
      activeBitmaps?.theme === settings.interfaceTheme ? activeBitmaps.slots : undefined;
    target.dataset["themeBitmaps"] = themeBitmapSlots.filter((slot) => slots?.[slot]).join(" ");
    for (const slot of themeBitmapSlots) {
      const paint = slots?.[slot];
      property(`--bitmap-${slot}-image`, paint && `url("foom-theme://bitmap/${paint.id}")`);
      property(`--bitmap-${slot}-opacity`, paint && String(paint.opacity));
      property(`--bitmap-${slot}-size`, paint && (paint.fit === "tile" ? "auto" : paint.fit));
      property(`--bitmap-${slot}-repeat`, paint && (paint.fit === "tile" ? "repeat" : "no-repeat"));
      property(`--bitmap-${slot}-position`, paint?.anchor.replace("-", " "));
    }
    applyInterfaceTypography(theme, target);
    for (const key of interfaceStates) property(`--state-${key}`, theme.states?.[key]);
    for (const key of ["radius", "panel-radius", "border", "shadow"] as const) {
      const value =
        theme.shape?.[key] ?? (key === "panel-radius" ? theme.shape?.radius : undefined);
      property(
        `--shape-${key}`,
        value === undefined ? undefined : `${String(value)}${key === "shadow" ? "" : "px"}`,
      );
    }
    target.dataset["themeReady"] = "true";
    target.style.colorScheme = theme.base;
    target.dataset["panelColor"] = settings.panelColor;
    target.dataset["panelContrast"] =
      settings.interfaceTheme === "high-contrast" ? "more" : "normal";
  };
  const off = source.subscribe((state) => {
    revision++;
    settings = state.settings;
    catalog = state.themes;
    apply();
  });
  const initialRevision = revision;
  void source.state().then(
    (state) => {
      if (!disposed && revision === initialRevision) {
        settings = state.settings;
        catalog = state.themes;
        apply();
      }
    },
    () => {},
  );
  media.addEventListener("change", apply);
  return () => {
    disposed = true;
    off();
    media.removeEventListener("change", apply);
    for (const key of [...interfaceColorNames, ...interfaceHighlightNames])
      target.style.removeProperty(`--${key}`);
    for (const key of properties) target.style.removeProperty(key);
    for (const key of [
      "font-interface",
      "font-mono",
      "type-scale",
      "type-weight",
      "type-strong-weight",
    ])
      target.style.removeProperty(`--${key}`);
    target.style.removeProperty("color-scheme");
    delete target.dataset["themeReady"];
    delete target.dataset["themeAreas"];
    delete target.dataset["themeGradients"];
    delete target.dataset["themeBitmaps"];
    delete target.dataset["panelColor"];
    delete target.dataset["panelContrast"];
  };
}
