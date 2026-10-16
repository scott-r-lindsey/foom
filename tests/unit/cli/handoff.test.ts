import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { handoffCommand } from "../../../src/cli/handoff";
import { command } from "../../../src/cli/commands";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function* input(...chunks: (string | Buffer)[]) {
  for (const chunk of chunks) yield await Promise.resolve(chunk);
}
const args = ["handoff", "--status", "done", "--summary-file", "-", "--idempotency-key", "key"];
it("uses the shared schema for stdin, files, links and read selectors", async () => {
  const request = await handoffCommand(
    [...args, "--link", "https://example.com", "--link", "https://example.org"],
    input("Hello", Buffer.from("\nworld")),
  );
  expect(request).toMatchObject({
    method: "handoff",
    params: { summary: "Hello\nworld", links: ["https://example.com", "https://example.org"] },
  });
  const dir = await mkdtemp(join(tmpdir(), "foom-handoff-"));
  dirs.push(dir);
  const file = join(dir, "summary.txt");
  await writeFile(file, "é".repeat(4096));
  expect(
    (
      await handoffCommand(
        args.map((arg) => (arg === "-" ? file : arg)),
        input(),
      )
    ).params["summary"],
  ).toHaveLength(4096);
  expect(command(["read-handoff", "child", "--seq", "2"])).toEqual({
    method: "read_handoff",
    params: { id: "child", seq: 2 },
  });
  expect(command(["read-handoff", "child"])).toEqual({
    method: "read_handoff",
    params: { id: "child" },
  });
});
it("refuses oversized, empty, invalid UTF-8 or control-bearing content and nonfiles", async () => {
  for (const chunks of [["x".repeat(8193)], [""], [Buffer.from([0xff])], ["bad\r"]])
    await expect(handoffCommand(args, input(...chunks))).rejects.toThrow("invalid_request");
  const dir = await mkdtemp(join(tmpdir(), "foom-handoff-"));
  dirs.push(dir);
  const file = join(dir, "summary");
  await writeFile(file, "x".repeat(8193));
  await expect(
    handoffCommand(
      args.map((arg) => (arg === "-" ? file : arg)),
      input(),
    ),
  ).rejects.toThrow("invalid_request");
  const folder = join(dir, "folder");
  await mkdir(folder);
  await expect(
    handoffCommand(
      args.map((arg) => (arg === "-" ? folder : arg)),
      input(),
    ),
  ).rejects.toThrow("invalid_request");
});
it.each(
  [
    [],
    ["wrong"],
    [...args, "--unknown", "value"],
    [...args, "--status", "blocked"],
    [...args, "--link"],
    args.filter((arg) => arg !== "--summary-file" && arg !== "-"),
    args.map((arg) => (arg === "-" ? "bad\0path" : arg)),
    [...args, ...Array.from({ length: 22 }, () => "extra")],
    [...args, "--link", "file:///tmp/file"],
  ].map((argv) => ({ argv })),
)("rejects malformed arguments $argv", async ({ argv }) => {
  await expect(handoffCommand(argv, input("content"))).rejects.toThrow("invalid_request");
});
it.each(
  [
    ["read-handoff"],
    ["read-handoff", "id", "--seq", "0"],
    ["read-handoff", "id", "--other", "1"],
  ].map((args) => ({ args })),
)("refuses invalid read arguments $args", ({ args }) => {
  expect(() => command(args)).toThrow("invalid_request");
});
