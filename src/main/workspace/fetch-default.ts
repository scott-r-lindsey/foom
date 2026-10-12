/** The caller serializes fetches per repository; discovery itself is read-only. */
export async function fetchAdvertisedDefault(
  remote: string,
  run: (args: string[]) => Promise<string>,
  validate: (branch: string) => Promise<void>,
): Promise<{ branch: string; commit: string }> {
  // Drain both processes even on failure so a subsequent fetch cannot overlap writes.
  const [fetched, advertised] = await Promise.allSettled([
    run(["fetch", "--prune", "--", remote]),
    run(["ls-remote", "--symref", "--", remote, "HEAD"]),
  ]);
  if (fetched.status === "rejected") throw new Error("Fetch failed");
  if (advertised.status === "rejected") throw new Error("Remote discovery failed");
  const ref = /^ref: (refs\/heads\/[^\n\t]+)\tHEAD$/mu.exec(advertised.value)?.[1];
  const head = /^([a-f0-9]{40,64})\tHEAD$/mu.exec(advertised.value)?.[1];
  if (!ref || !head) throw new Error("Remote default branch is unavailable");
  const branch = ref.slice("refs/heads/".length);
  await validate(branch);
  try {
    await run(["cat-file", "-e", `${head}^{commit}`]);
  } catch {
    await run(["fetch", "--no-write-fetch-head", "--", remote, ref]);
  }
  const commit = (await run(["rev-parse", "--verify", `${head}^{commit}`])).trim();
  return { branch, commit };
}
