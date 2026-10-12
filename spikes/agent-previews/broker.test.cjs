"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Board, LIMITS, PreviewBroker } = require("./broker.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foom-agent-preview-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tree = path.join(root, "tree");
  const other = path.join(root, "other");
  fs.mkdirSync(path.join(tree, "docs"), { recursive: true });
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(tree, "mockup.html"), "<h1>mock</h1>");
  fs.writeFileSync(path.join(tree, "docs", "plan.md"), "# plan");
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(tree, `p${i}.md`), `# ${i}`);
  fs.writeFileSync(path.join(tree, "notes.txt"), "text");
  fs.writeFileSync(path.join(tree, ".env.md"), "SECRET=1");
  fs.writeFileSync(path.join(other, "secret.md"), "# outside");
  fs.symlinkSync(path.join(other, "secret.md"), path.join(tree, "escape.md"));
  fs.symlinkSync(path.join(tree, ".env.md"), path.join(tree, "hidden-link.md"));
  return { root, tree, other };
}

const agent = (tree, extra = {}) => ({
  generation: `g-${Math.random()}`,
  sessionId: "s1",
  agent: "claude",
  name: "Claude Code",
  worktree: tree,
  ...extra,
});

test("opens a document in the caller's worktree into the landing spot without moving focus", (t) => {
  const { tree } = fixture(t);
  const board = new Board({ landing: "t2", empty: ["t2", "t3"], focused: "t1" });
  const broker = new PreviewBroker({ board });
  const result = broker.open(agent(tree), { path: "mockup.html" });
  assert.equal(result.placement, "landing");
  assert.equal(result.kind, "html");
  assert.equal(result.reused, false);
  assert.match(result.previewId, /^pv_[0-9a-f]{32}$/);
  assert.equal(board.focused, "t1");
  const second = broker.open(agent(tree), { path: "docs/plan.md" });
  assert.equal(second.placement, "empty");
  const third = broker.open(agent(tree), { path: "p0.md" });
  assert.equal(third.placement, "sidebar", "a full board never adds a column or replaces a tile");
});

test("the same file twice reuses the preview, by any spelling", (t) => {
  const { tree } = fixture(t);
  const broker = new PreviewBroker({ board: new Board({ landing: "t2" }) });
  const actor = agent(tree);
  const first = broker.open(actor, { path: "docs/plan.md" });
  for (const spelling of ["./docs/plan.md", "docs//plan.md", path.join(tree, "docs", "plan.md")]) {
    const again = broker.open(actor, { path: spelling });
    assert.equal(again.previewId, first.previewId);
    assert.equal(again.placement, "existing");
    assert.equal(again.reused, true);
  }
  assert.equal(broker.list(actor, {}).previews.length, 1);
});

test("refuses paths outside the worktree, hidden targets, other types and malformed input", (t) => {
  const { tree, other } = fixture(t);
  const broker = new PreviewBroker({ limits: { ...LIMITS, burst: 100 } });
  const actor = agent(tree);
  const code = (input) => {
    try {
      broker.open(actor, input);
      return "ok";
    } catch (error) {
      return error.code;
    }
  };
  assert.equal(code({ path: "../other/secret.md" }), "forbidden");
  assert.equal(code({ path: path.join(other, "secret.md") }), "forbidden");
  assert.equal(code({ path: "/etc/hostname.md" }), "forbidden");
  assert.equal(code({ path: "escape.md" }), "forbidden", "symlink out of the worktree");
  assert.equal(code({ path: "hidden-link.md" }), "forbidden", "symlink onto a hidden name");
  assert.equal(code({ path: ".env.md" }), "forbidden");
  assert.equal(code({ path: "notes.txt" }), "unsupported_type");
  assert.equal(code({ path: "missing.md" }), "not_found");
  assert.equal(code({ path: "" }), "invalid_request");
  assert.equal(code({ path: "a\nb.md" }), "invalid_request");
  assert.equal(code({ path: `${"a".repeat(1100)}.md` }), "invalid_request");
  assert.equal(code({ path: "p0.md", worktree: "/" }), "invalid_request", "no caller-supplied root");
  assert.equal(code({ path: 7 }), "invalid_request");
  assert.equal(code(null), "invalid_request");
});

test("agents see and close only their own previews; foreign IDs look unknown", (t) => {
  const { tree } = fixture(t);
  const broker = new PreviewBroker({ board: new Board({ empty: ["t2", "t3"] }) });
  const mine = agent(tree);
  const theirs = agent(tree, { sessionId: "s2" });
  const a = broker.open(mine, { path: "p0.md" });
  const b = broker.open(theirs, { path: "p0.md" });
  assert.notEqual(a.previewId, b.previewId, "same file, separate owners");
  assert.deepEqual(
    broker.list(mine, {}).previews.map((p) => p.previewId),
    [a.previewId],
  );
  assert.throws(() => broker.close(mine, { previewId: b.previewId }), { code: "not_found" });
  assert.throws(() => broker.close(mine, { previewId: "pv_nope" }), { code: "not_found" });
  assert.deepEqual(broker.close(mine, { previewId: a.previewId }), { previewId: a.previewId, closed: true });
  assert.equal(broker.list(theirs, {}).previews.length, 1);
});

test("count and rate limits refuse instead of evicting", (t) => {
  const { tree } = fixture(t);
  let now = 0;
  const broker = new PreviewBroker({ now: () => now });
  const actor = agent(tree);
  for (let i = 0; i < LIMITS.perAgent; i++) broker.open(actor, { path: `p${i}.md` });
  assert.throws(() => broker.open(actor, { path: "p5.md" }), { code: "capacity" });
  assert.equal(broker.list(actor, {}).previews.length, LIMITS.perAgent, "nothing evicted");
  // Six calls used (four opens, one refused, plus this reuse); the bucket is empty.
  broker.open(actor, { path: "p0.md" });
  assert.throws(() => broker.open(actor, { path: "p0.md" }), { code: "rate_limited" });
  now += LIMITS.refillMs;
  assert.equal(broker.open(actor, { path: "p0.md" }).reused, true);
});

test("the instance-wide cap holds across many agents", (t) => {
  const { tree } = fixture(t);
  const broker = new PreviewBroker();
  const actors = Array.from({ length: 4 }, (_, i) => agent(tree, { sessionId: `s${i}` }));
  let opened = 0;
  for (const actor of actors)
    for (let i = 0; i < LIMITS.perAgent; i++) {
      try {
        broker.open(actor, { path: `p${i}.md` });
        opened++;
      } catch (error) {
        assert.equal(error.code, "capacity");
      }
    }
  assert.equal(opened, LIMITS.total);
});

test("a preview the human closed never refills a tile for the same agent", (t) => {
  const { tree } = fixture(t);
  const board = new Board({ landing: "t2" });
  const broker = new PreviewBroker({ board });
  const actor = agent(tree);
  const first = broker.open(actor, { path: "mockup.html" });
  broker.humanClose(first.previewId);
  assert.equal(board.landing, "t2", "closing leaves the landing spot");
  const again = broker.open(actor, { path: "mockup.html" });
  assert.equal(again.placement, "sidebar");
  assert.equal(board.landing, "t2", "the landing spot is untouched");
  assert.equal(broker.humanShow(again.previewId), "landing", "the human can still show it");
});

test("exit or takeover releases ownership; worktree removal closes previews", (t) => {
  const { tree } = fixture(t);
  const broker = new PreviewBroker({ board: new Board({ empty: ["t2"] }) });
  const actor = agent(tree);
  const opened = broker.open(actor, { path: "mockup.html" });
  broker.revoke(actor);
  assert.equal(broker.list(actor, {}).previews.length, 0);
  assert.throws(() => broker.close(actor, { previewId: opened.previewId }), { code: "not_found" });
  assert.equal(broker.previews.size, 1, "the human keeps the preview");
  broker.worktreeRemoved(tree);
  assert.equal(broker.previews.size, 0);
});

test("audit events carry fixed fields only", (t) => {
  const { tree } = fixture(t);
  const broker = new PreviewBroker();
  broker.open(agent(tree), { path: "docs/plan.md" });
  assert.deepEqual(Object.keys(broker.events[0]).sort(), ["action", "at", "outcome", "path", "preview", "session"]);
  assert.equal(JSON.stringify(broker.events).includes("# plan"), false);
});
