import { discoverRegistrations } from "./electron-registration.mjs";

export function selectSuiteFiles(files, { patterns }) {
  if (patterns.length === 0 || process.env.NODE_OPTIONS !== undefined) return files;
  try {
    const inventory = discoverRegistrations(files, { patterns });
    const selected = files.filter((file) => {
      const entry = inventory.get(file);
      return (
        !entry?.registrations?.length ||
        entry.fileHooks ||
        entry.registrations.some(({ matches }) => matches)
      );
    });
    return selected.length === 0 ? files : selected;
  } catch {
    // Leave discovery failures to real workers.
    return files;
  }
}
