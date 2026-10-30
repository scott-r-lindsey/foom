import { expect, test } from "vitest";
import type { TerminalPaste } from "../../../../src/shared/image-paste.d";
import { TerminalInputOrder } from "../../../../src/renderer/terminal/input-order";

test("paste precedes typed Enter, with one synchronous paste emission and unchanged ordinary input", async () => {
  const order = new TerminalInputOrder();
  const sent: string[] = [];
  const live = () => true;
  order.input(
    1,
    () => {
      sent.push("before");
    },
    live,
  );
  const first = Promise.withResolvers<TerminalPaste>();
  const pasting = order.paste(
    first.promise,
    (result) => {
      if (result.kind === "text")
        order.input(
          result.text.length,
          () => {
            sent.push(result.text);
          },
          live,
        );
    },
    live,
  );
  order.input(
    1,
    () => {
      sent.push("\r");
    },
    live,
  );
  const second = order.paste(
    Promise.resolve({ kind: "text", text: "second" }),
    (result) => {
      if (result.kind === "text")
        order.input(
          1,
          () => {
            sent.push(result.text);
          },
          live,
        );
    },
    live,
  );
  order.input(
    1,
    () => {
      sent.push("after");
    },
    live,
  );
  expect(sent).toEqual(["before"]);
  first.resolve({ kind: "text", text: "paste" });
  await pasting;
  await second;
  await Promise.resolve();
  await Promise.resolve();
  expect(sent).toEqual(["before", "paste", "\r", "second", "after"]);
});
test("failed or abandoned paste never replays buffered input into this or a different attachment", async () => {
  for (const kind of ["failed", "unsupported", "cancelled"] as const) {
    const order = new TerminalInputOrder();
    const sent: string[] = [];
    const first = Promise.withResolvers<TerminalPaste>();
    const pending = order.paste(
      first.promise,
      () => {},
      () => true,
    );
    order.input(
      1,
      () => {
        sent.push("\r");
      },
      () => true,
    );
    first.resolve({ kind });
    await pending;
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([]);
  }
  const order = new TerminalInputOrder();
  let live = true;
  const sent: string[] = [];
  const pending = order.paste(
    new Promise(() => {}),
    () => {
      sent.push("paste");
    },
    () => live,
  );
  order.input(
    1,
    () => {
      sent.push("late");
    },
    () => live,
  );
  live = false;
  order.cancel();
  await pending;
  await Promise.resolve();
  expect(sent).toEqual([]);
  order.input(
    1,
    () => {
      sent.push("hidden");
    },
    () => false,
  );
  expect(sent).toEqual([]);
});
test("empty clipboard permits explicit input; overflow cancels pending paste with a bounded failure", async () => {
  const order = new TerminalInputOrder();
  const results: TerminalPaste[] = [];
  const sent: string[] = [];
  const empty = order.paste(
    Promise.resolve({ kind: "empty" }),
    (result) => {
      results.push(result);
    },
    () => true,
  );
  order.input(
    1,
    () => {
      sent.push("enter");
    },
    () => true,
  );
  await empty;
  await Promise.resolve();
  await Promise.resolve();
  expect(sent).toEqual(["enter"]);
  const blocked = order.paste(
    new Promise(() => {}),
    (result) => {
      results.push(result);
    },
    () => true,
  );
  order.input(
    65537,
    () => {
      sent.push("overflow");
    },
    () => true,
  );
  await blocked;
  await Promise.resolve();
  await Promise.resolve();
  expect(results.at(-1)).toEqual({ kind: "failed" });
  expect(sent).toEqual(["enter"]);
});
test("rejection and send/apply failures release the queue without exposing or replaying content", async () => {
  const order = new TerminalInputOrder();
  const results: TerminalPaste[] = [];
  await order.paste(
    Promise.reject(new Error("private")),
    (result) => {
      results.push(result);
    },
    () => true,
  );
  expect(results).toEqual([{ kind: "failed" }]);
  await expect(
    order.paste(
      Promise.resolve({ kind: "text", text: "x" }),
      () => {
        throw new Error("closed");
      },
      () => true,
    ),
  ).rejects.toThrow("closed");
  const gate = Promise.withResolvers<TerminalPaste>();
  const attempted: string[] = [];
  const paste = order.paste(
    gate.promise,
    () => {},
    () => true,
  );
  order.input(
    1,
    () => {
      attempted.push("send");
      throw new Error("send");
    },
    () => true,
  );
  order.input(
    1,
    () => {
      attempted.push("must be discarded");
    },
    () => true,
  );
  gate.resolve({ kind: "empty" });
  await paste;
  await order.paste(
    Promise.resolve({ kind: "empty" }),
    () => {
      attempted.push("queue released");
    },
    () => true,
  );
  expect(attempted).toEqual(["send", "queue released"]);
});
