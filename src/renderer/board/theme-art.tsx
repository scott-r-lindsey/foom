import { createContext, use, useState } from "react";
import type { CSSProperties } from "react";
import type {
  ActiveThemeBitmaps,
  ThemeBitmapPaint,
  ThemeBitmapSlot,
} from "../../shared/theme-bitmap";

export const ThemeArtContext = createContext<ActiveThemeBitmaps | undefined>(undefined);

/** A mounted surface keeps its piece until that piece is no longer available. */
export function themeArtChoice(
  pieces: readonly ThemeBitmapPaint[],
  previous: string | undefined,
  random: () => number = Math.random,
): ThemeBitmapPaint | undefined {
  return pieces.find(({ id }) => id === previous) ?? pieces[Math.floor(random() * pieces.length)];
}

export function ThemeArt({
  slot,
  className,
  style,
  hidden,
  direction,
}: {
  slot: ThemeBitmapSlot;
  className?: string;
  style?: CSSProperties;
  hidden?: boolean;
  direction?: "horizontal" | "vertical";
}) {
  const pieces = use(ThemeArtContext)?.slots[slot];
  const [id, setId] = useState<string>();
  const paint = pieces && themeArtChoice(pieces, id);
  if (paint?.id !== id) setId(paint?.id);
  if (!paint) return null;
  const url = `foom-theme://bitmap/${paint.id}`;
  const intrinsic = paint.fit === "none";
  const limit = paint.size === undefined ? undefined : `${String(paint.size)}cqmin`;
  return (
    <div
      aria-hidden="true"
      className={className ? `theme-art ${className}` : "theme-art"}
      data-theme-art={slot}
      data-direction={direction}
      data-fit={paint.fit}
      hidden={hidden}
      style={{
        ...style,
        opacity: paint.opacity,
        ...(!intrinsic && {
          backgroundImage: `url("${url}")`,
          backgroundSize: paint.fit === "tile" ? "auto" : paint.fit,
          backgroundRepeat: paint.fit === "tile" ? "repeat" : "no-repeat",
          backgroundPosition: paint.anchor.replace("-", " "),
        }),
      }}
    >
      {intrinsic && (
        <div className="theme-art-intrinsic" data-anchor={paint.anchor}>
          <img src={url} alt="" draggable={false} style={{ maxWidth: limit, maxHeight: limit }} />
        </div>
      )}
    </div>
  );
}
