export function boundedRegex(pattern: string): RegExp {
  if (
    pattern.length === 0 ||
    pattern.length > 128 ||
    /[()*+?{}|]/.test(pattern) ||
    /\\[^sSdDwW\\.[\]\-^$]/.test(pattern)
  )
    throw new Error("Unsafe detection regex");
  return new RegExp(pattern, "iu");
}
