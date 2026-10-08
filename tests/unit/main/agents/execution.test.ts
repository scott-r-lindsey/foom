import { expect, test } from "vitest";
import { AgentExecution } from "../../../../src/main/agents/execution";
import type { ExecutionTransition } from "../../../../src/shared/execution";

test("independent invocations retain active turns through tools and silent periods", () => {
  const events: ExecutionTransition[] = [];
  const a = new AgentExecution(
    "a",
    1,
    (event) => events.push(event),
    () => 20,
  );
  const b = new AgentExecution("b", 2, (event) => events.push(event));
  a.transition("idle", "title");
  expect(a.snapshot().turn).toBe(0);
  a.transition("working", "hook");
  b.transition("working", "title");
  a.transition("working", "title");
  expect(events).toHaveLength(3);
  a.transition("idle", "hook");
  expect(b.snapshot().phase).toBe("working");
  expect(events.at(-1)).toMatchObject({
    terminalId: "a",
    launch: 1,
    turn: 1,
    revision: 3,
    from: "working",
    to: "idle",
    source: "hook",
    at: 20,
  });
  a.transition("idle", "title");
  expect(events).toHaveLength(4);
  a.transition("working", "title");
  expect(a.snapshot().turn).toBe(2);
});

test("permission evidence beats a spinner, positive progress resumes the same turn, exit is final", () => {
  const machine = new AgentExecution("a", 1, () => {});
  machine.transition("working", "title");
  machine.transition("blocked", "hook");
  machine.transition("working", "title");
  expect(machine.snapshot().phase).toBe("blocked");
  machine.transition("working", "hook");
  expect(machine.snapshot()).toMatchObject({ phase: "working", turn: 1 });
  machine.transition("blocked", "screen");
  machine.transition("working", "title");
  expect(machine.snapshot().turn).toBe(1);
  machine.transition("exited", "exit");
  machine.transition("working", "hook");
  expect(machine.snapshot().phase).toBe("exited");
  const copy = machine.snapshot();
  copy.phase = "working";
  expect(machine.snapshot().phase).toBe("exited");
});
