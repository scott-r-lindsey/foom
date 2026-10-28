import { createContext, use } from "react";

export const ConfigThemeLauncherContext = createContext<(() => void) | undefined>(undefined);

export function CustomThemeHint() {
  const open = use(ConfigThemeLauncherContext);
  return (
    <p className="custom-theme-hint">
      Want something else? Ask a{" "}
      <button type="button" onClick={open}>
        config agent
      </button>{" "}
      for any theme you can describe.
    </p>
  );
}
