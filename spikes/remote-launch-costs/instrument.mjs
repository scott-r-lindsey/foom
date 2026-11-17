import { readFile } from "node:fs/promises";

// Test-build-only instrumentation: no production metrics, paths or wire changes.
export function instrumentation(baseline) {
  const clock = `function cost1098(stage) { process.stderr.write(JSON.stringify({cost1098: stage, at: performance.timeOrigin + performance.now()}) + '\\n'); }`;
  const replace = (source, from, to) => {
    if (!source.includes(from)) throw new Error(`Profiling anchor changed: ${from}`);
    return source.replace(from, to);
  };
  return {
    name: "remote-launch-costs",
    setup(api) {
      api.onLoad(
        { filter: /terminal-host\/remote\/(main|agent-discovery)\.ts$/ },
        async ({ path }) => {
          let source = await readFile(path, "utf8");
          if (path.endsWith("/main.ts")) {
            if (baseline)
              source =
                [
                  "./daemon",
                  "./agent-helper",
                  "./host-recipe",
                  "./agent-launch",
                  "./agent-discovery",
                  "../../node-common/repository-setup-run",
                ]
                  .map((path) => `import ${JSON.stringify(path)};`)
                  .join("\n") +
                "\n" +
                source;
            const hash =
              'const build = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");';
            source = replace(
              source,
              hash,
              `cost1098("self-hash-start"); ${hash} cost1098("self-hash-end");`,
            );
            source = replace(
              source,
              "export async function runHost(argv: readonly string[] = process.argv): Promise<void> {",
              'export async function runHost(argv: readonly string[] = process.argv): Promise<void> { cost1098("entry");',
            );
            source = replace(
              source,
              "const socket = createConnection(path);",
              'cost1098("socket-start"); const socket = createConnection(path);',
            );
            source = replace(
              source,
              'socket.once("connect", () => {',
              'socket.once("connect", () => { cost1098("socket-connected");',
            );
          } else {
            source = replace(
              source,
              "  const launchEnv = environment ??",
              '  cost1098("discovery-start"); const launchEnv = environment ??',
            );
            source = replace(
              source,
              "  return { command, env: launchEnv, version, help };",
              '  cost1098("discovery-end"); return { command, env: launchEnv, version, help };',
            );
          }
          return { contents: `${clock}\n${source}`, loader: "ts" };
        },
      );
    },
  };
}
