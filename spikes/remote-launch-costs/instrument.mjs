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
            const hash =
              'const build = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");';
            if (baseline) {
              source = replace(source, hash, "");
              source = replace(
                source,
                "  if (argv.length !== 3",
                `  ${hash}\n  if (argv.length !== 3`,
              );
            }
            source = replace(
              source,
              hash,
              `cost1098("self-hash-start"); ${hash} cost1098("self-hash-end");`,
            );
            source = replace(
              source,
              "export function runHost(argv: readonly string[] = process.argv): void {",
              'export function runHost(argv: readonly string[] = process.argv): void { cost1098("entry");',
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
