import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

it("forwards an explicit empty target set for bounded board-only waits", () => {
  expect(command(["wait-for", "--board-after", "cursor", "--timeout-ms", "0"])).toEqual({
    method: "wait_for",
    params: { ids: [], boardAfter: "cursor", timeoutMs: 0 },
  });
});

it("posts bounded JSON questions and withdraws by post ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foom-question-cli-"));
  try {
    const text = join(directory, "post.txt");
    await writeFile(text, "Decision requested");
    const questions = [
      {
        title: "Proceed?",
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      },
    ];
    const args = [
      "post",
      "--thread",
      "t",
      "--kind",
      "question",
      "--text-file",
      text,
      "--questions-file",
      "-",
      "--idempotency-key",
      "k",
    ];
    async function* json(value: string) {
      yield await Promise.resolve(value);
    }
    expect(await boardCommand(args, json(JSON.stringify(questions)))).toMatchObject({
      method: "board_post",
      params: { thread: "t", kind: "question", text: "Decision requested", questions },
    });
    await expect(boardCommand(args, json("{"))).rejects.toThrow("invalid_request");
    await expect(boardCommand(args, json("[]"))).rejects.toThrow("invalid_request");
    expect(
      await boardCommand(["resolve", "t", "--post", "q", "--idempotency-key", "k"], input()),
    ).toEqual({
      method: "board_resolve",
      params: { thread: "t", post: "q", idempotencyKey: "k" },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
