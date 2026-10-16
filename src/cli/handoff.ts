import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { handoffRequest } from "../node-common/handoff";
import { ControlError } from "../node-common/control-validation";
import type { Command, ConsoleIo } from "./types";

/** Read only a bounded regular file or stdin. File contents never enter argv or errors. */
export async function handoffCommand(
  args: readonly string[],
  input: ConsoleIo["input"],
): Promise<Command> {
  if (args[0] !== "handoff" || args.length > 27) throw new ControlError("invalid_request");
  const flags = new Map<string, string>();
  const links: string[] = [];
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      value === undefined ||
      !flag ||
      !["--status", "--summary-file", "--link", "--idempotency-key"].includes(flag)
    )
      throw new ControlError("invalid_request");
    if (flag === "--link") links.push(value);
    else {
      if (flags.has(flag)) throw new ControlError("invalid_request");
      flags.set(flag, value);
    }
  }
  const params = {
    status: flags.get("--status"),
    links,
    idempotencyKey: flags.get("--idempotency-key"),
  };
  handoffRequest({ ...params, summary: "validate before reading" });
  const path = flags.get("--summary-file");
  if (!path || path.includes("\0")) throw new ControlError("invalid_request");
  const chunks: Buffer[] = [];
  if (path === "-") {
    let size = 0;
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 8192) throw new ControlError("invalid_request");
      chunks.push(bytes);
    }
  } else {
    const file = await open(
      path,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK),
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 8192) throw new ControlError("invalid_request");
      const bytes = Buffer.alloc(8193);
      let size = 0;
      while (size < bytes.length) {
        const read = await file.read(bytes, size, bytes.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > 8192) throw new ControlError("invalid_request");
      chunks.push(bytes.subarray(0, size));
    } finally {
      await file.close();
    }
  }
  let summary: string;
  try {
    summary = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new ControlError("invalid_request");
  }
  return { method: "handoff", params: handoffRequest({ ...params, summary }) };
}
