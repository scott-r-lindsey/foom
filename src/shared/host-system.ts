import type { HostRequirements } from "./registered-hosts.d";
/** os-release is data, never shell source. Reject expansion, escapes and duplicate keys. */
export function hostDistro(source: string): HostRequirements["distro"] {
  if (source.length > 65536 || source.includes("\0") || source.includes("\r")) return "unknown";
  const fields = new Map<string, string>();
  for (const line of source.split("\n")) {
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(?:"([^"\\$`]*?)"|'([^'\\$`]*?)'|([A-Za-z0-9._-]*))$/u.exec(
      line,
    );
    if (!match || !match[1] || fields.has(match[1])) return "unknown";
    fields.set(match[1], match[2] ?? match[3] ?? match[4] ?? "");
  }
  const family = (id: string) => {
    if (["debian", "ubuntu"].includes(id)) return "debian";
    if (["rhel", "centos", "rocky", "almalinux", "fedora", "amzn"].includes(id)) return "rhel";
    if (id === "arch") return "arch";
    return undefined;
  };
  return (
    family(fields.get("ID") ?? "") ??
    fields
      .get("ID_LIKE")
      ?.split(" ")
      .map(family)
      .find((value) => value !== undefined) ??
    "unknown"
  );
}
export function hostLibc(source: string): HostRequirements["libc"] {
  const match = /^glibc (\d{1,4})\.(\d{1,4})\n?$/u.exec(source);
  if (!match) return "unsupported";
  return Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 28)
    ? "supported"
    : "too-old";
}
