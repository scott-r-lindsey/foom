import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { nativeDeadline } from "./native-test-policy";

type ObserverResult = { stdout: string; stderr: string; elapsed: number; observedElapsed: number };

export function windowsObserver(
  cwd: string,
  env: NodeJS.ProcessEnv,
  event: string,
  input?: string,
  observationDelay = 0,
) {
  let complete: (error: Error | null) => void = () => undefined;
  // Resolve with errors as data so a late failure cannot become an unhandled
  // rejection before afterAll joins the supervisors.
  const closed = new Promise<Error | null>((resolve) => {
    complete = resolve;
  });
  const result = new Promise<ObserverResult>((resolveResult, reject) => {
    const child = execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolve("tests/helpers/observer-process.ps1"),
      ],
      { cwd, env, timeout: nativeDeadline(10000) },
      (error, _stdout, stderr) => {
        const failure = error
          ? new Error(`Observer supervisor failed: ${stderr}`, { cause: error })
          : null;
        complete(failure);
        if (failure) reject(failure);
        else reject(new Error("Observer supervisor exited without a parent result"));
      },
    );
    let output = "";
    child.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
      if (!output.includes("\n")) return;
      try {
        const value: unknown = JSON.parse(output);
        if (
          typeof value !== "object" ||
          value === null ||
          !("stdout" in value) ||
          typeof value.stdout !== "string" ||
          !("stderr" in value) ||
          typeof value.stderr !== "string" ||
          !("elapsed" in value) ||
          typeof value.elapsed !== "number" ||
          !Number.isFinite(value.elapsed) ||
          value.elapsed < 0 ||
          !("observedElapsed" in value) ||
          typeof value.observedElapsed !== "number" ||
          !Number.isFinite(value.observedElapsed) ||
          value.observedElapsed < 0
        ) {
          throw new Error("Invalid observer supervisor result");
        }
        resolveResult({
          stdout: value.stdout,
          stderr: value.stderr,
          elapsed: value.elapsed,
          observedElapsed: value.observedElapsed,
        });
      } catch (error) {
        reject(new Error("Invalid observer supervisor output", { cause: error }));
      }
    });
    child.stdin?.end(
      `${JSON.stringify({ event, input: input ?? null, deadline: nativeDeadline(5000), observationDelay })}\n`,
    );
  });
  return { result, closed };
}
