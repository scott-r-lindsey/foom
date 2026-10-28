import { interfaceAreas, interfaceStates } from "../../shared/user-interface-theme";
import type { ThemeCatalog } from "../../shared/theme-file";
import {
  interfaceColorNames,
  interfaceHighlightNames,
  resolveInterfaceTheme,
} from "../../shared/interface-themes";
import type { Settings } from "../../shared/setup";
import type { SetupSource } from "../preflight/setup-source.d";

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
    target.style.removeProperty("color-scheme");
    delete target.dataset["themeReady"];
    delete target.dataset["panelColor"];
    delete target.dataset["panelContrast"];
  };
}
