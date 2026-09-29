import { TerminalManager } from "./terminal-manager";
import { hostRequest } from "./terminal-host-protocol";
import type { HostResponse } from "./shared/terminal-host";

const port = process.parentPort;
const send = (message: HostResponse) => {
  port.postMessage(message);
};
const manager = new TerminalManager((id, code) => {
  send({ type: "exit", id, code });
});
const owned = new Set<string>();
port.on("message", (event: { data: unknown }) => {
  const message = event.data;
  if (message === "shutdown") {
    void manager
      .shutdown()
      .then(() => {
        process.exit(0);
      })
      .catch(() => {
        process.exit(1);
      });
    return;
  }
  if (!hostRequest(message)) return;
  const { id, request } = message;
  void (async () => {
    let lines: string[] = [];
    if (message.type === "shutdown") {
      await manager.shutdown();
      owned.clear();
    } else if (message.type === "create") {
      if (owned.has(id)) throw new Error("Duplicate terminal");
      manager.create(message.spec, id, message.dark);
      owned.add(id);
    } else {
      if (!owned.has(id)) throw new Error("Unknown terminal");
      switch (message.type) {
        case "theme":
          manager.setTheme(id, message.dark);
          break;
        case "attach":
          await manager.attach(id, (token, data) => {
            send({ type: "data", id, view: message.view, token, data });
          });
          break;
        case "detach":
          manager.detach(id);
          break;
        case "kill":
          manager.kill(id);
          owned.delete(id);
          break;
        case "write":
          manager.write(id, message.data);
          break;
        case "resize":
          manager.resize(id, message.cols, message.rows);
          break;
        case "acknowledge":
          manager.acknowledge(id, message.token, message.count);
          break;
        case "tail":
          lines = await manager.tail(id, message.lines);
          break;
      }
    }
    send({ type: "result", id, request, lines });
  })().catch(() => {
    send({ type: "error", id, request });
  });
});
process.once("exit", () => {
  manager.dispose();
});
