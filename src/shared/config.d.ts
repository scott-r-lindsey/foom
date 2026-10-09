import type { ThemeKind } from "./theme-file";
import type { SoundKind } from "./sound";
import type { Settings } from "./setup";
import type { CONFIG_SETTINGS } from "./config-settings";
export type ConfigSetting = (typeof CONFIG_SETTINGS)[number];
export type ConfigSettings = Partial<Pick<Settings, ConfigSetting>>;

export type ConfigFolderKind = "config" | "settings" | ThemeKind | "sounds" | SoundKind;
