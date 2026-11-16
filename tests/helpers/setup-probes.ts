import type * as Checker from "../../src/node-common/repository-setup-check";
export const fakeSetupProbes = (): Checker.SetupProbeDependencies => ({
  platform: { os: "linux", arch: "x64", distro: "debian", nodeAbi: true },
  home: "/fixture",
  env: { HOME: "/fixture", PATH: "/fixture/bin" },
  probe: () => Promise.reject(new Error("Unexpected fixture probe")),
  resolve: () => Promise.resolve("/fixture/brew"),
  dispose: () => Promise.resolve(),
  invocation: (command, args) => ({ command, args }),
});
export const mockScopedProbes =
  (create: typeof Checker.setupProbeDependencies): typeof Checker.withSetupProbeDependencies =>
  async (env, home, signal, excluded, action) => {
    const deps = await create(env, home, signal, excluded);
    try {
      return await action(deps);
    } finally {
      await deps.dispose();
    }
  };
