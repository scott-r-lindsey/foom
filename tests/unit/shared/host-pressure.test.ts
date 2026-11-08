import { expect, test } from "vitest";
import { HostAdmission, hostPressure } from "../../../src/shared/host-pressure";
import type { HostResources } from "../../../src/shared/host-pressure.d";
const GIB = 1024 ** 3;
const healthy = { cores: 4, load: [0, 0, 0], memoryTotal: 16 * GIB, memoryAvailable: 8 * GIB };
const measure = () => Promise.resolve(healthy);

test.each([{ load: [4, 0, 0] }, { memoryAvailable: GIB - 1 }, { memoryAvailable: 1.5 * GIB }])(
  "refuses each independent pressure signal with numeric retry facts: %j",
  async (overrides) => {
    await expect(
      new HostAdmission().reserve(
        () => Promise.resolve({ ...healthy, ...overrides }),
        () => 0,
      ),
    ).rejects.toMatchObject({
      reason: "host_busy",
      pressure: { measured: true, sessions: 0, budget: 4 },
    });
  },
);
test("running human and child agents exhaust the machine budget independently of load", async () => {
  await expect(new HostAdmission().reserve(measure, () => 4)).rejects.toMatchObject({
    reason: "host_busy",
  });
});
test("a concurrent burst admits exactly the budget and releases failures idempotently", async () => {
  const admission = new HostAdmission();
  const burst = await Promise.allSettled(
    Array.from({ length: 10 }, () => admission.reserve(measure, () => 0)),
  );
  const admitted = burst.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  expect(admitted).toHaveLength(4);
  expect(burst.filter((result) => result.status === "rejected")).toHaveLength(6);
  for (const entry of admitted) {
    entry.release();
    entry.release();
  }
  const next = await admission.reserve(measure, () => 0);
  expect(next.pressure).toMatchObject({ reservations: 0 });
  expect(hostPressure(next.pressure)).toBe(true);
  next.release();
});
test("memory scales the budget and tiny machines retain one slot", async () => {
  for (const [memoryTotal, budget] of [
    [8 * GIB, 2],
    [3 * GIB, 1],
  ] as const) {
    const slot = await new HostAdmission().reserve(
      () => Promise.resolve({ ...healthy, memoryTotal, memoryAvailable: 2 * GIB }),
      () => 0,
    );
    expect(slot.pressure).toMatchObject({ budget });
    slot.release();
  }
});
test("unreadable or invalid measurements allow launches explicitly unmeasured", async () => {
  const bad: Partial<HostResources>[] = [
    { cores: 0 },
    { cores: 1.1 },
    { load: [] },
    { load: [-1] },
    { load: [Infinity] },
    { memoryTotal: 0 },
    { memoryTotal: NaN },
    { memoryAvailable: -1 },
    { memoryAvailable: Infinity },
    { memoryAvailable: 17 * GIB },
  ];
  for (const data of bad) {
    const slot = await new HostAdmission().reserve(
      () => Promise.resolve({ ...healthy, ...data }),
      () => 100,
    );
    expect(slot.pressure).toEqual({ measured: false });
    slot.release();
  }
  const slot = await new HostAdmission().reserve(
    () => Promise.reject(new Error("unreadable")),
    () => 100,
  );
  expect(slot.pressure).toEqual({ measured: false });
  slot.release();
});
test("pressure validator rejects untrusted nonnumeric and extra fields", () => {
  expect(hostPressure({ measured: false })).toBe(true);
  for (const value of [
    null,
    "",
    1,
    {},
    { measured: true },
    { measured: 1 },
    { measured: false, path: "/secret" },
  ])
    expect(hostPressure(value)).toBe(false);
  const valid = {
    measured: true,
    loadPerCore: 0.5,
    memoryAvailable: GIB,
    memoryTotal: 16 * GIB,
    sessions: 1,
    reservations: 0,
    budget: 4,
  };
  expect(hostPressure(valid)).toBe(true);
  for (const value of [-1, Infinity, NaN, "1", 0.5])
    expect(hostPressure({ ...valid, sessions: value })).toBe(false);
});
