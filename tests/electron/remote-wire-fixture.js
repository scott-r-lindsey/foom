const { appendFileSync } = require("node:fs");

// Observe the fixture's real bootstrap/protocol without changing its bytes.
// Never retain terminal text, commands, credentials or whole protocol payloads.
function observeRemoteSsh(input, output, file, uploadSize, checkPrelude = false) {
  const { RemoteFrames, remoteRequest, remoteResponse } =
    require("../../build/shared/remote-host-protocol.js");
  let records = 0;
  // Fragment rows retain their own lengths; data totals cover unfragmented messages.
  const totals = {
    outputFrames: 0,
    outputChars: 0,
    writes: 0,
    inputChars: 0,
    acks: 0,
    ackChars: 0,
  };
  const expected = new Set();
  const tokens = new Set();
  const record = (event) => {
    if (records++ < 2048 || event.kind === "exit")
      appendFileSync(
        file,
        `${JSON.stringify({ at: Date.now(), pid: process.pid, ...event, totals: { ...totals } })}\n`,
      );
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
        if (kind === "request") {
          if (value.type === "write") {
            totals.writes++;
            totals.inputChars += value.data.length;
            return;
          }
          if (value.type === "acknowledge") {
            totals.acks++;
            totals.ackChars += value.count;
            return;
          }
          if (typeof value.request === "number") expected.add(value.request);
        } else {
          if (value.type === "data") {
            totals.outputFrames++;
            totals.outputChars += value.data.length;
            if (tokens.has(value.token)) return;
            if (tokens.size < 128) tokens.add(value.token);
          }
          if (value.type === "result" && !expected.delete(value.request)) return;
        }
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
  let prelude = Buffer.alloc(0);
  input.on("data", (bytes) => {
    if (checkPrelude) {
      prelude = Buffer.concat([prelude, bytes]);
      const end = prelude.indexOf(10);
      if (end < 0) return;
      const size = Number(prelude.subarray(0, end).toString());
      if (!Number.isInteger(size) || size < 1 || size > 65536)
        throw new Error("Invalid fixture prelude");
      if (prelude.length < end + 1 + size) return;
      bytes = prelude.subarray(end + 1 + size);
      prelude = Buffer.alloc(0);
      checkPrelude = false;
    }
    const skip = Math.min(uploadRemaining, bytes.length);
    uploadRemaining -= skip;
    observe(requests, bytes.subarray(skip), "request", remoteRequest);
  });
  return record;
}

module.exports = { observeRemoteSsh };
