const { appendFileSync } = require("node:fs");

// Observe the fixture's real bootstrap/protocol without delaying or changing it.
// Never retain terminal text, commands, credentials or whole protocol payloads.
function observeRemoteSsh(input, output, file, uploadSize) {
  const { RemoteFrames, remoteRequest, remoteResponse } =
    require("../../build/shared/remote-host-protocol.js");
  let records = 0;
  const record = (event) => {
    if (records++ < 2048 || event.kind === "exit")
      appendFileSync(file, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...event })}\n`);
  };
  record({ kind: "start" });
  const requests = new RemoteFrames();
  const responses = new RemoteFrames();
  let header = Buffer.alloc(0);
  let ready = false;
  let uploadRemaining = 0;
  let failed = false;
  const observe = (frames, bytes, kind, valid) => {
    if (failed) return;
    try {
      frames.push(bytes, (value) => {
        if (!valid(value)) throw new Error("Invalid fixture frame");
        record({
          kind,
          type: value.type,
          id: value.id,
          request: value.request,
          state: value.state,
          reattach: value.reattach,
          background: value.theme?.background,
          count: value.count,
          length: value.data?.length,
          backgrounds:
            value.type === "data"
              ? value.data
                  .split("\x1b]11;")
                  .slice(1)
                  .flatMap((part) => part.match(/^(#[0-9a-f]{6}|rgb:[0-9a-f/]+)/i)?.[1] ?? [])
              : undefined,
        });
      });
    } catch {
      failed = true;
      record({ kind: "observer-error" });
    }
  };
  output.on("data", (bytes) => {
    if (!ready) {
      header = Buffer.concat([header, bytes]);
      for (;;) {
        const end = header.indexOf(10);
        if (end < 0) return;
        const line = header.subarray(0, end).toString("ascii");
        header = header.subarray(end + 1);
        if (line === "FOOM-UPLOAD") uploadRemaining = uploadSize;
        if (line === "FOOM-READY") {
          ready = true;
          bytes = header;
          header = Buffer.alloc(0);
          break;
        }
      }
    }
    observe(responses, bytes, "response", remoteResponse);
  });
  input.on("data", (bytes) => {
    const skip = Math.min(uploadRemaining, bytes.length);
    uploadRemaining -= skip;
    observe(requests, bytes.subarray(skip), "request", remoteRequest);
  });
  return record;
}

module.exports = { observeRemoteSsh };
