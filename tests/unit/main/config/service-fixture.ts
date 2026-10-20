import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, vi } from "vitest";
import { configPart } from "../../../../src/main/config/approval";
import { ConfigService } from "../../../../src/main/config/service";
import type { ConfigServiceDependencies } from "../../../../src/main/config/service";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import { interfaceThemes } from "../../../../src/shared/interface-themes";
import type { ConfigSettings } from "../../../../src/shared/config";

export const roots: string[] = [];
export const services: ConfigService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

export const palette = interfaceThemes["eclipse-dark"];
export const theme = (name: string, colors = palette.colors) =>
  JSON.stringify({ kind: "theme", name, base: palette.base, colors });

export async function fixture({
  baseline: initial,
  appliedText: initialText,
  themeDigests = [],
  realWatch = false,
  ...options
}: Partial<Omit<ConfigServiceDependencies, "baseline" | "appliedText">> & {
  baseline?: string;
  appliedText?: string;
  themeDigests?: [string, string][];
  realWatch?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "foom-config-service-"));
  roots.push(root);
  const folder = path.join(root, "config");
  let baseline: string | null = initial ?? null;
  let copy: string | null = initialText ?? null;
  const themeBaselines = new Map<string, string>(themeDigests);
  const applied: ConfigSettings[] = [];
  const listeners: ((file: string | null) => void)[] = [];
  const statuses: unknown[] = [];
  const service = new ConfigService({
    root: folder,
    defaults: configPart(DEFAULT_SETTINGS),
    apply: (values) => {
      applied.push(values);
    },
    baseline: {
      get: () => baseline,
      set: (value) => {
        baseline = value;
        return Promise.resolve();
      },
    },
    appliedText: {
      get: () => copy,
      set: (text) => {
        copy = text;
        return Promise.resolve();
      },
    },
    themeBaseline: {
      get: (file) => themeBaselines.get(file) ?? null,
      set: (file, value) => {
        if (value === null) themeBaselines.delete(file);
        else themeBaselines.set(file, value);
        return Promise.resolve();
      },
    },
    onStatus: (status) => {
      statuses.push(status);
    },
    ...(realWatch
      ? {}
      : {
          watch: (_directory: string, listener: (file: string | null) => void) => {
            listeners.push(listener);
            return { close: vi.fn() };
          },
        }),
    delay: 1,
    ...options,
  });
  services.push(service);
  const write = (file: string, content: string) => writeFile(path.join(folder, file), content);
  const read = (file: string) => readFile(path.join(folder, file), "utf8");
  return {
    root,
    folder,
    service,
    applied,
    listeners,
    statuses,
    write,
    read,
    baseline: () => baseline,
    copy: () => copy,
    themeBaselines,
    /** Decides the proposal currently shown, as the Settings banner does. */
    decide: (decision: string) => service.decide(decision, service.status().pending?.id),
    settings: (values: object) =>
      write("settings.json", JSON.stringify({ kind: "settings", ...values })),
  };
}

/** Restarts the service on the same folder and profile, as relaunching Foom does. */
export async function restart(f: Awaited<ReturnType<typeof fixture>>) {
  await f.service.dispose();
  const again = new ConfigService({
    root: f.folder,
    defaults: configPart(DEFAULT_SETTINGS),
    apply: () => {},
    baseline: { get: () => f.baseline(), set: () => Promise.resolve() },
    appliedText: { get: () => f.copy(), set: () => Promise.resolve() },
    themeBaseline: {
      get: (file) => f.themeBaselines.get(file) ?? null,
      set: (file, value) => {
        if (value === null) f.themeBaselines.delete(file);
        else f.themeBaselines.set(file, value);
        return Promise.resolve();
      },
    },
    watch: () => ({ close: () => {} }),
  });
  services.push(again);
  await again.initialize();
  return again;
}
