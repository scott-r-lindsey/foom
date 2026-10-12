import { expect, test, vi } from "vitest";
import { fetchAdvertisedDefault } from "../../../../src/main/workspace/fetch-default";
const head = "a".repeat(40);
const advertisement = `ref: refs/heads/main\tHEAD\n${head}\tHEAD\n`;
function setup() {
  const run = vi.fn((args: string[]) =>
    Promise.resolve(args[0] === "ls-remote" ? advertisement : args[0] === "rev-parse" ? head : ""),
  );
  const validate = vi.fn(() => Promise.resolve());
  return { run, validate };
}
test("starts discovery alongside fetch and skips another fetch for an existing commit", async () => {
  const { run, validate } = setup();
  let fetched: (value: string) => void = () => {};
  run.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        fetched = resolve;
      }),
  );
  const result = fetchAdvertisedDefault("origin", run, validate);
  expect(run.mock.calls.map((call) => call[0][0])).toEqual(["fetch", "ls-remote"]);
  fetched("");
  expect(await result).toEqual({ branch: "main", commit: head });
  expect(validate).toHaveBeenCalledWith("main");
  expect(run.mock.calls.filter((call) => call[0][0] === "fetch")).toHaveLength(1);
});
test("an absent advertised object triggers an explicit fetch; a failed one refuses", async () => {
  const { run, validate } = setup();
  run.mockImplementation((args) =>
    args[0] === "cat-file"
      ? Promise.reject(new Error("absent"))
      : Promise.resolve(args[0] === "ls-remote" ? advertisement : head),
  );
  await fetchAdvertisedDefault("origin", run, validate);
  expect(run).toHaveBeenCalledWith([
    "fetch",
    "--no-write-fetch-head",
    "--",
    "origin",
    "refs/heads/main",
  ]);
  run.mockImplementation((args) =>
    args[0] === "ls-remote"
      ? Promise.resolve(advertisement)
      : args[1] === "--prune"
        ? Promise.resolve("")
        : Promise.reject(new Error("unavailable")),
  );
  await expect(fetchAdvertisedDefault("origin", run, validate)).rejects.toThrow("unavailable");
});
test.each(["fetch", "ls-remote"])(
  "failed %s refuses without reading a stale commit",
  async (failing) => {
    const { run, validate } = setup();
    run.mockImplementation((args) =>
      args[0] === failing
        ? Promise.reject(new Error("untrusted output"))
        : Promise.resolve(advertisement),
    );
    await expect(fetchAdvertisedDefault("origin", run, validate)).rejects.toThrow(
      failing === "fetch" ? "Fetch failed" : "Remote discovery failed",
    );
    expect(run).toHaveBeenCalledTimes(2);
  },
);
test.each(["", `ref: refs/heads/main\tHEAD\n`, `${head}\tHEAD\n`])(
  "refuses malformed advertisements",
  async (advertisement) => {
    const { run, validate } = setup();
    run.mockResolvedValue(advertisement);
    await expect(fetchAdvertisedDefault("origin", run, validate)).rejects.toThrow("default branch");
    expect(validate).not.toHaveBeenCalled();
  },
);
test("branch validation precedes object lookup", async () => {
  const { run, validate } = setup();
  validate.mockRejectedValue(new Error("invalid branch"));
  await expect(fetchAdvertisedDefault("origin", run, validate)).rejects.toThrow("invalid branch");
  expect(run).toHaveBeenCalledTimes(2);
});
