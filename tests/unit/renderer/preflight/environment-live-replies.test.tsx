// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { EnvironmentSettings } from "../../../../src/renderer/preflight/environment-settings";
import { viewStream } from "../../../fixtures/view-stream";
import type { EnvironmentState, EnvironmentApi } from "../../../../src/shared/environment";

afterEach(cleanup);
function state(a: string, b: string): EnvironmentState {
  return {
    lists: {
      all: [
        { name: "ALPHA", value: a, secret: false },
        { name: "BETA", value: b, secret: false },
      ],
    },
    windows: false,
    secrets: true,
  };
}
function fixture() {
  const stream = viewStream();
  stream.data.environment = state("a0", "b0");
  const reply = Promise.withResolvers<EnvironmentState>();
  const source = {
    views: stream.api,
    environmentState: vi
      .fn<EnvironmentApi["environmentState"]>()
      .mockResolvedValue(stream.data.environment),
    saveEnvironment: vi.fn<EnvironmentApi["saveEnvironment"]>().mockReturnValue(reply.promise),
    removeEnvironment: vi.fn<EnvironmentApi["removeEnvironment"]>().mockReturnValue(reply.promise),
    readShellEnvironment: vi.fn<EnvironmentApi["readShellEnvironment"]>().mockResolvedValue([]),
    importEnvironment: vi.fn<EnvironmentApi["importEnvironment"]>().mockReturnValue(reply.promise),
  };
  render(<EnvironmentSettings source={source} />);
  const push = (next: EnvironmentState) => {
    stream.data.environment = next;
    stream.push("environment");
  };
  return { source, reply, push };
}
test.each([false, true])(
  "late save replies preserve newer pushed rows and subsequent edits (batched=%s)",
  async (batched) => {
    const { source, reply, push } = fixture();
    const alpha = await screen.findByLabelText("ALPHA value");
    fireEvent.change(alpha, { target: { value: "a1" } });
    fireEvent.focusOut(alpha);
    await waitFor(() => {
      expect(source.saveEnvironment).toHaveBeenCalledOnce();
    });
    const old = state("a1", "b0");
    act(() => {
      push(old);
    });
    if (batched) {
      await act(async () => {
        push(state("a1", "b1"));
        reply.resolve(old);
        await reply.promise;
      });
    } else {
      act(() => {
        push(state("a1", "b1"));
      });
      expect(screen.getByLabelText("BETA value")).toHaveProperty("value", "b1");
      await act(async () => {
        reply.resolve(old);
        await reply.promise;
      });
    }
    expect(screen.getByLabelText("BETA value")).toHaveProperty("value", "b1");
    fireEvent.click(
      within(screen.getByRole("group", { name: "BETA" })).getByRole("button", { name: "Secret" }),
    );
    await waitFor(() => {
      expect(source.saveEnvironment).toHaveBeenLastCalledWith({
        scope: "all",
        previous: "BETA",
        name: "BETA",
        value: "b1",
        secret: true,
      });
    });
  },
);
test("acknowledging a sent draft preserves edits made while saving and takes other rows from current truth", async () => {
  const { source, reply, push } = fixture();
  const alpha = await screen.findByLabelText("ALPHA value");
  fireEvent.change(alpha, { target: { value: "a1" } });
  fireEvent.focusOut(alpha);
  await waitFor(() => {
    expect(source.saveEnvironment).toHaveBeenCalledOnce();
  });
  act(() => {
    push(state("a1", "b0"));
  });
  fireEvent.change(alpha, { target: { value: "a2" } });
  act(() => {
    push(state("a1", "b1"));
  });
  await act(async () => {
    reply.resolve(state("a1", "b0"));
    await reply.promise;
  });
  expect(screen.getByLabelText("ALPHA value")).toHaveProperty("value", "a2");
  expect(screen.getByLabelText("BETA value")).toHaveProperty("value", "b1");
  fireEvent.focusOut(screen.getByLabelText("ALPHA value"));
  await waitFor(() => {
    expect(source.saveEnvironment).toHaveBeenLastCalledWith({
      scope: "all",
      previous: "ALPHA",
      name: "ALPHA",
      value: "a2",
      secret: false,
    });
  });
});
test("a late remove reply cannot restore an older value in another row", async () => {
  const { source, reply, push } = fixture();
  fireEvent.click(await screen.findByRole("button", { name: "Remove ALPHA" }));
  await waitFor(() => {
    expect(source.removeEnvironment).toHaveBeenCalledWith("all", "ALPHA");
  });
  const old = state("a1", "b0");
  const next = state("a1", "b1");
  const beta = next.lists.all.filter((row) => row.name === "BETA");
  act(() => {
    push({ ...next, lists: { all: beta } });
  });
  await act(async () => {
    reply.resolve(old);
    await reply.promise;
  });
  expect(screen.queryByLabelText("ALPHA value")).toBeNull();
  expect(screen.getByLabelText("BETA value")).toHaveProperty("value", "b1");
});
