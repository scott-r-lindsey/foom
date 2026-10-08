import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface WindowPlacement {
  id: string;
  display: number;
  bounds: { x: number; y: number; width: number; height: number };
  maximized: boolean;
  scale: number;
}
export interface DisplayArea {
  id: number;
  workArea: WindowPlacement["bounds"];
}

export function parsePlacements(value: unknown): WindowPlacement[] {
  if (!Array.isArray(value) || value.length > 32) return [];
  const ids = new Set<string>();
  return value.flatMap((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("id" in item) ||
      typeof item.id !== "string" ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(item.id) ||
      ids.has(item.id) ||
      !("display" in item) ||
      typeof item.display !== "number" ||
      !Number.isSafeInteger(item.display) ||
      !("maximized" in item) ||
      typeof item.maximized !== "boolean" ||
      !("scale" in item) ||
      typeof item.scale !== "number" ||
      !Number.isInteger(item.scale) ||
      item.scale < 80 ||
      item.scale > 150 ||
      !("bounds" in item)
    )
      return [];
    const bounds = item.bounds;
    if (
      typeof bounds !== "object" ||
      bounds === null ||
      !("x" in bounds) ||
      !("y" in bounds) ||
      !("width" in bounds) ||
      !("height" in bounds)
    )
      return [];
    const { x, y, width, height } = bounds;
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof width !== "number" ||
      typeof height !== "number" ||
      ![x, y, width, height].every(Number.isSafeInteger) ||
      Math.abs(x) > 100000 ||
      Math.abs(y) > 100000 ||
      width < 1 ||
      height < 1 ||
      width > 20000 ||
      height > 20000
    )
      return [];
    ids.add(item.id);
    return [
      {
        id: item.id,
        display: item.display,
        maximized: item.maximized,
        scale: item.scale,
        bounds: { x, y, width, height },
      },
    ];
  });
}

/** Clamp all edges to the connected work area, including negative-coordinate displays. */
export function placeWindow(
  saved: WindowPlacement,
  displays: readonly DisplayArea[],
  primary: DisplayArea,
): WindowPlacement {
  const display = displays.find((item) => item.id === saved.display) ?? primary;
  const area = display.workArea;
  const width = Math.min(saved.bounds.width, area.width);
  const height = Math.min(saved.bounds.height, area.height);
  return {
    ...saved,
    display: display.id,
    bounds: {
      x: Math.max(area.x, Math.min(saved.bounds.x, area.x + area.width - width)),
      y: Math.max(area.y, Math.min(saved.bounds.y, area.y + area.height - height)),
      width,
      height,
    },
  };
}

export async function loadPlacements(userData: string): Promise<WindowPlacement[]> {
  try {
    const raw = await readFile(join(userData, "windows.json"), "utf8");
    return raw.length <= 32768 ? parsePlacements(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}
export async function savePlacements(
  userData: string,
  placements: readonly WindowPlacement[],
): Promise<void> {
  await mkdir(userData, { recursive: true, mode: 0o700 });
  const file = join(userData, "windows.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(placements), { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
