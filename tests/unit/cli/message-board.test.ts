import { expect, it } from "vitest";
import { boardCommand } from "../../../src/cli/message-board";
import { command } from "../../../src/cli/commands";
async function* input() {
  yield await Promise.resolve("hello");
}
it("maps all board commands and their exact flags", async () => {
  expect(
    await boardCommand(["threads", "--state", "waiting-human", "--after", "t"], input()),
  ).toEqual({ method: "board_threads", params: { state: "waiting-human", after: "t" } });
  expect(await boardCommand(["threads"], input())).toEqual({ method: "board_threads", params: {} });
  expect(await boardCommand(["read", "t", "--after", "p"], input())).toEqual({
    method: "board_read",
    params: { thread: "t", after: "p" },
  });
  expect(await boardCommand(["resolve", "t", "--idempotency-key", "k"], input())).toEqual({
    method: "board_resolve",
    params: { thread: "t", idempotencyKey: "k" },
  });
  const newPost = [
    "post",
    "--new",
    "--to",
    "a",
    "--to",
    "b",
    "--title",
    "Title",
    "--kind",
    "request",
    "--text-file",
    "-",
    "--link",
    "#973",
    "--idempotency-key",
    "k",
  ];
  expect(await boardCommand(newPost, input())).toMatchObject({
    method: "board_post",
    params: { to: ["a", "b"], text: "hello", title: "Title", links: ["#973"] },
  });
  expect(
    await boardCommand(
      [
        "post",
        "--thread",
        "t",
        "--kind",
        "answer",
        "--text-file",
        "-",
        "--idempotency-key",
        "reply",
      ],
      input(),
    ),
  ).toMatchObject({ params: { thread: "t", text: "hello" } });
  expect(command(["wait-for", "--until-event", "--board-after", "cursor"])).toEqual({
    method: "wait_for",
    params: { untilEvent: true, boardAfter: "cursor" },
  });
});
it("rejects malformed flags and combinations before reading input", async () => {
  const bad = [
    ["unknown"],
    ["threads", "--author", "human"],
    ["threads", "--new"],
    ["threads", "--link", "#1"],
    ["read"],
    ["resolve", "t"],
    ["read", "t", "--idempotency-key", "k"],
    ["post", "--new", "--new"],
    ["threads", "--state"],
    ["threads", "junk", "x"],
    ["threads", "--state", "open", "--state", "open"],
    ["post", "--text-file", "-", "--kind", "answer", "--idempotency-key", "k"],
    [
      "post",
      "--thread",
      "t",
      "--text-file",
      "-",
      "--kind",
      "answer",
      "--idempotency-key",
      "k",
      "--author",
      "human",
    ],
    [
      "post",
      "--thread",
      "t",
      "--new",
      "--text-file",
      "-",
      "--kind",
      "answer",
      "--idempotency-key",
      "k",
    ],
  ];
  for (const args of bad)
    await expect(boardCommand(args, input())).rejects.toThrow("invalid_request");
});
