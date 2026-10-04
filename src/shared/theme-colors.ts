/** sRGB colors are validated before conversion. WCAG 2.2 relative luminance. */
function rgb(color: string): [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16) / 255,
    Number.parseInt(color.slice(3, 5), 16) / 255,
    Number.parseInt(color.slice(5, 7), 16) / 255,
  ];
}
function linear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
function luminance(color: string): number {
  const [r, g, b] = rgb(color);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
export function contrast(a: string, b: string): number {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** CIE Lab, D65 reference white; Euclidean distance is Delta E 1976. */
function lab(color: string): [number, number, number] {
  const [red, green, blue] = rgb(color);
  const r = linear(red),
    g = linear(green),
    b = linear(blue);
  const f = (value: number) =>
    value > (6 / 29) ** 3 ? Math.cbrt(value) : value / (3 * (6 / 29) ** 2) + 4 / 29;
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export function colorDistance(a: string, b: string): number {
  const [l1, a1, b1] = lab(a),
    [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
export function hueSaturation(color: string): { hue: number; saturation: number } {
  const [r, g, b] = rgb(color);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min;
  if (delta === 0) return { hue: 0, saturation: 0 };
  const hue =
    60 * (max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4);
  return { hue: (hue + 360) % 360, saturation: delta / (1 - Math.abs(max + min - 1)) };
}
