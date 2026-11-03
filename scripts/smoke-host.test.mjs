import assert from "node:assert/strict";
import { test } from "node:test";
import { smokeOptions, smokeSteps } from "./smoke-host.mjs";

const options = { host: "fixture-cloud", codeFolder: "~/foom", repository: "/fixture/repo" };
const pass = { state: "pass" };
const result = {
  ok: true,
  facts: { folder: pass, tools: [{ id: "git", state: "ready" }] },
  checkout: { state: "absent" },
};
function fixture(failAt, reason = "origin-auth", alter = () => {}) {
  const calls = [];
  const lines = [];
  const hub = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === failAt) throw new Error(reason);
      if (method === "preflight") {
        const value = structuredClone({
          ssh: pass,
          platform: pass,
          artifact: pass,
          result,
          repositories: [{ repository: options.repository, origin: pass, checkout: result }],
        });
        alter(value);
        return value;
      }
      if (method === "enroll") return result;
      if (method === "clone") return { ...result, checkout: { state: "clean" } };
      if (method === "worktree") return { path: "/fixture/worktree", identity: "a".repeat(64) };
      if (method === "launch") return `\n${params.marker}:123\n`;
      if (method === "verify") assert.equal(params.pid, "123");
    },
    async restart() {
      calls.push({ method: "restart" });
      if (failAt === "restart") throw new Error(reason);
    },
  };
  return { calls, lines, run: () => smokeSteps(options, hub, (line) => lines.push(line)) };
}

test("smoke parser rejects SSH options and unknown or incomplete flags", () => {
  assert.equal(
    smokeOptions(["--", "user@fixture", "--code-folder", "~/code"]).codeFolder,
    "~/code",
  );
  for (const args of [
    [],
    ["-oProxyCommand=bad"],
    ["host;bad"],
    ["host", "--keep"],
    ["host", "--repository"],
  ])
    assert.throws(() => smokeOptions(args));
});

test("smoke lifecycle restarts hub and cleans only its explicit fixture identifiers", async () => {
  const f = fixture();
  assert.equal(await f.run(), 0);
  assert.deepEqual(
    f.calls.map(({ method }) => method),
    [
      "preflight",
      "enroll",
      "clone",
      "worktree",
      "launch",
      "restart",
      "verify",
      "foreign",
      "cleanup",
    ],
  );
  const before = f.calls.find(({ method }) => method === "launch").params;
  const after = f.calls.find(({ method }) => method === "verify").params;
  assert.equal(after.id, before.id);
  assert.equal(after.marker, before.marker);
  assert.equal(after.pid, "123");
  assert.match(f.lines.at(-1), /^PASS host smoke/);
  assert.ok(f.lines.some((line) => line.startsWith("SKIP legacy")));
});

for (const [field, reason] of [
  ["ssh", "unreachable"],
  ["platform", "unsupported"],
  ["platform", "libc-too-old"],
  ["artifact", "artifact-unavailable"],
]) {
  test(`preflight stops at ${field}: ${reason} without mutations`, async () => {
    const f = fixture(undefined, undefined, (value) => {
      value[field] = { state: "fail", reason };
    });
    assert.equal(await f.run(), 1);
    assert.deepEqual(
      f.calls.map(({ method }) => method),
      ["preflight"],
    );
    assert.ok(f.lines.includes(`FAIL preflight: ${reason}`));
  });
}
for (const reason of [
  "origin-auth",
  "origin-host-key",
  "origin-unreachable",
  "timed-out",
  "checkout-invalid",
]) {
  test(`preflight preserves fixed Git failure ${reason}`, async () => {
    const f = fixture(undefined, undefined, (value) => {
      value.repositories[0].origin = { state: "fail", reason };
    });
    assert.equal(await f.run(), 1);
    assert.deepEqual(
      f.calls.map(({ method }) => method),
      ["preflight"],
    );
    assert.ok(f.lines.includes(`FAIL preflight: ${reason}`));
  });
}
for (const mutate of [
  (v) => {
    v.result.facts.folder = { state: "fail", reason: "folder-missing" };
  },
  (v) => {
    v.artifact = { state: "not-checked" };
  },
  (v) => {
    v.result.facts.tools = [];
  },
  (v) => {
    v.repositories = [];
  },
  (v) => {
    v.repositories[0].checkout = { ok: false, reason: "checkout-refused" };
  },
]) {
  test("incomplete preflight never fabricates a pass", async () => {
    const f = fixture(undefined, undefined, mutate);
    assert.equal(await f.run(), 1);
    assert.deepEqual(
      f.calls.map(({ method }) => method),
      ["preflight"],
    );
  });
}
for (const method of [
  "enroll",
  "clone",
  "worktree",
  "launch",
  "restart",
  "verify",
  "foreign",
  "cleanup",
]) {
  test(`failure at ${method} still attempts cleanup and exits nonzero`, async () => {
    const f = fixture(method);
    assert.equal(await f.run(), 1);
    assert.equal(f.calls.at(-1).method, "cleanup");
    assert.match(f.lines.at(-1), /^FAIL host smoke/);
  });
}
test("raw failure output never reaches diagnostics", async () => {
  const f = fixture("launch", "private ssh output /secret/key bearer token");
  assert.equal(await f.run(), 1);
  assert.ok(!f.lines.join("\n").includes("private"));
});
