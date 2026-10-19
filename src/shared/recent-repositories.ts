/** Git activity window shared by scans and the existing-results view. */
export function isRecent(time: number | null, now: number, days = 30): boolean {
  return time !== null && now - time <= days * 86_400_000;
}

export function clampRecentDays(days: number): number {
  return Math.max(1, Math.min(365, Math.round(days)));
}
