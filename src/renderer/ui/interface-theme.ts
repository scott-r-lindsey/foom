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
  let settings: Pick<Settings, "interfaceTheme" | "colorMode" | "panelColor"> = {
    interfaceTheme: "follow",
    colorMode: "system",
    panelColor: "vivid",
  };
  let catalog: ThemeCatalog | undefined;
  let disposed = false;
  let revision = 0;
  const apply = () => {
    const dark = settings.colorMode === "system" ? media.matches : settings.colorMode === "dark";
    const theme = resolveInterfaceTheme(settings.interfaceTheme, dark, catalog);
    for (const key of interfaceColorNames) target.style.setProperty(`--${key}`, theme.colors[key]);
    target.style.setProperty("--highlight", theme.colors.highlight ?? theme.colors.accent);
    target.style.setProperty(
      "--highlight-deep",
      theme.colors["highlight-deep"] ?? theme.colors["accent-deep"],
    );
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
    target.style.removeProperty("color-scheme");
    delete target.dataset["panelColor"];
    delete target.dataset["panelContrast"];
  };
}
