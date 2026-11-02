import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const failureReasons = new Set([
  "unreachable",
  "version-mismatch",
  "provider-invalid",
  "configuration-changed",
  "invalid-reply",
  "cancelled",
  "facts-unavailable",
  "libc-too-old",
  "libc-unsupported",
  "unsupported",
  "artifact-unavailable",
  "folder-missing",
  "folder-refused",
  "unsafe-folder",
  "origin-unavailable",
  "clone-failed",
  "checkout-refused",
  "origin-auth",
  "origin-host-key",
  "origin-unreachable",
  "timed-out",
  "checkout-invalid",
  "not-checked",
  "git-unavailable",
  "marker-missing",
  "interrupted",
  "cleanup-failed",
  "request-timed-out",
  "request-refused",
  "transport-closed",
]);

export function smokeOptions(args) {
  if (args[0] === "--") args = args.slice(1);
  const [host, ...rest] = args;
  if (!host || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,252}$/.test(host))
    throw new Error(
      "usage: pnpm run smoke:host -- ALIAS [--code-folder FOLDER] [--repository PATH]",
    );
  const options = { host, codeFolder: "~/foom", repository: process.cwd() };
  while (rest.length) {
    const flag = rest.shift();
    const value = rest.shift();
    if (!value || !["--code-folder", "--repository"].includes(flag))
      throw new Error("invalid smoke option");
    options[flag === "--repository" ? "repository" : "codeFolder"] = value;
  }
  options.repository = resolve(options.repository);
  return options;
}

export function requireCheck(check) {
  if (check?.state !== "pass") throw new Error(check?.reason ?? "not-checked");
}

export function requireResult(result) {
  if (!result?.ok) throw new Error(result?.reason ?? "invalid-reply");
  return result;
}

/** The same sequence is driven by fixture hubs in CI; it never selects a real CLI. */
export async function smokeSteps(options, hub, log = console.log) {
  const suffix = randomBytes(12).toString("hex");
  const state = {
    branch: `foom-smoke-${suffix}`,
    id: `smoke-${suffix}`,
    foreignId: `smoke-foreign-${suffix}`,
    marker: `FOOM_SMOKE_${suffix}`,
  };
  let failed = false;
  let interrupted = false;
  const interrupt = () => {
    failed = true;
    interrupted = true;
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, interrupt);
  let passed = 0;
  const step = async (name, work) => {
    try {
      if (interrupted && name !== "clean up sessions, worktree and registration")
        throw new Error("interrupted");
      const value = await work();
      passed++;
      log(`PASS ${name}`);
      return value;
    } catch (error) {
      failed = true;
      // Only our fixed reasons, never raw SSH/Git/PTY/exception text.
      const reason = failureReasons.has(error?.message) ? error.message : "check-failed";
      log(`FAIL ${name}: ${reason}`);
      throw error;
    }
  };
  try {
    await step("preflight", async () => {
      const preflight = await hub.call("preflight", options);
      for (const name of ["ssh", "platform", "artifact"]) requireCheck(preflight[name]);
      const facts = requireResult(preflight.result).facts;
      requireCheck(facts.folder);
      if (facts.tools?.find((tool) => tool.id === "git")?.state !== "ready")
        throw new Error("git-unavailable");
      const repo = preflight.repositories.find((repo) => repo.repository === options.repository);
      if (!repo) throw new Error("origin-unavailable");
      requireCheck(repo.origin);
      requireResult(repo.checkout);
    });
    await step("enroll host", async () => {
      state.enrolled = true;
      requireResult(await hub.call("enroll", options));
    });
    await step("clone or reuse checkout", async () => {
      const result = requireResult(await hub.call("clone", options));
      if (!result.checkout || result.checkout.state === "absent")
        throw new Error("checkout-invalid");
    });
    await step("create remote worktree", async () => {
      state.creating = true;
      state.tree = await hub.call("worktree", { ...options, branch: state.branch });
    });
    await step("launch fixture and print marker", async () => {
      state.launching = true;
      const text = await hub.call("launch", { ...options, ...state });
      state.pid = text.match(new RegExp(`(?:^|\\n)${state.marker}:(\\d+)\\r?(?:\\n|$)`))?.[1];
      if (!state.pid) throw new Error("marker-missing");
    });
    await step("restart hub", () => hub.restart());
    await step("same session, PID and replay", async () => {
      await hub.call("verify", { ...options, ...state });
    });
    await step("foreign profile isolation and End", () =>
      hub.call("foreign", { ...options, ...state }),
    );
    log("SKIP legacy End: existing legacy sessions belong to the user; never stopped by smoke");
    log("SKIP 24h idle soak: manual qualification step");
  } catch {
    // Every refusal is printed by its owning step; cleanup still runs.
  } finally {
    try {
      await step("clean up sessions, worktree and registration", () =>
        state.enrolled ? hub.call("cleanup", { ...options, ...state }) : undefined,
      );
    } catch {
      log(
        `Recovery identifiers: ${state.id}, ${state.foreignId}${state.tree ? `, ${state.tree.path}` : ""}`,
      );
    }
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, interrupt);
  log(`${failed ? "FAIL" : "PASS"} host smoke: ${passed} steps passed`);
  return failed ? 1 : 0;
}

export async function electronHub(
  options,
  directory,
  environment = process.env,
  started = () => {},
  fixtureGuard,
) {
  const { _electron } = require("playwright");
  const { electronLaunch } = require("../tests/electron/display-isolation.js");
  const config = join(directory, "smoke.json");
  await writeFile(
    config,
    JSON.stringify({ ...options, root, profile: join(directory, "profile"), fixtureGuard }),
  );
  let app;
  const start = async () => {
    const env = { ...environment, FOOM_SMOKE_CONFIG: config };
    delete env.NODE_OPTIONS;
    app = await _electron.launch({
      ...electronLaunch({
        env,
        args: [
          join(root, "scripts/smoke-host-hub.cjs"),
          `--user-data-dir=${join(directory, "profile")}`,
        ],
      }),
      timeout: 30000,
    });
    started(app.process().pid);
  };
  const stop = async () => {
    if (!app) return;
    const current = app;
    try {
      await current.evaluate(async () => {
        const hub = await globalThis.smokeHub;
        hub.dispose();
      });
    } finally {
      await current.close();
      app = undefined;
    }
  };
  await start();
  return {
    call: async (method, params) => {
      if (!app && method === "cleanup") await start();
      return app.evaluate(
        async (_electron, { method, params }) => (await globalThis.smokeHub)[method](params),
        { method, params },
      );
    },
    restart: async () => {
      await stop();
      await start();
    },
    close: stop,
  };
}

export async function runSmokeHost(args) {
  const options = smokeOptions(args);
  await access(join(root, "build/main/setup/hosts.js"));
  const directory = await mkdtemp(join(tmpdir(), "foom-host-smoke-"));
  let hub;
  try {
    hub = await electronHub(options, directory);
    return await smokeSteps(options, hub);
  } finally {
    try {
      await hub?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runSmokeHost(process.argv.slice(2));
  } catch {
    console.error(
      "FAIL host smoke: unable to start; use a built checkout and Xvfb on Linux (see docs/validation.md)",
    );
    process.exitCode = 1;
  }
}
