import { describe, expect, it, vi } from "vitest";
import { run } from "../../../src/cli/cli";

describe("console entry", () => {
  it("reports version and protocol without contacting the app", () => {
    expect(run(["--version"], "1.2.3").output).toBe("foom 1.2.3 (protocol 1)");
    expect(run(["--version", "--json"], "1.2.3").output).toEqual({ version: "1.2.3", protocol: 1 });
    expect(run([], "1").code).toBe(0);
    expect(run(["--help"], "1").code).toBe(0);
  });
  it("reserves offline config validation without reading or executing the input", () => {
    expect(run(["--validate-config", "/untrusted/config"], "1")).toEqual({
      output: { error: "config_schema_unavailable" },
      error: true,
      code: 2,
    });
    for (const args of [["--validate-config"], ["--eval", "evil"], ["--version", "extra"]])
      expect(run(args, "1").code).toBe(2);
  });
  it("writes the entry result and exit status to the console", async () => {
    vi.stubGlobal("FOOM_VERSION", "1.2.3");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const error = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const argv = process.argv;
    const exitCode = process.exitCode;
    try {
      process.argv = ["foom", "foom", "--version"];
      await import("../../../src/cli/main");
      expect(write).toHaveBeenCalledWith("foom 1.2.3 (protocol 1)\n");
      vi.resetModules();
      process.argv = ["foom", "foom", "--bad"];
      await import("../../../src/cli/main");
      expect(error).toHaveBeenCalledWith('{"error":"invalid_request"}\n');
      expect(process.exitCode).toBe(2);
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      vi.unstubAllGlobals();
    }
  });
});
