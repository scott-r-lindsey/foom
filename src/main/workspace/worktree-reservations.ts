/** Named branches share a reservation; detached checkouts reserve only their own path. */
export function worktreeReservation(
  repository: string,
  path: string,
  branch: string | null | undefined,
): string {
  return `${repository}\0${branch ?? `:detached:${path}`}`;
}
