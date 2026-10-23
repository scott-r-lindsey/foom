// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ArmedConfirmation, ConfirmationClient } from "../../../../src/shared/confirmation";
import { useConfirmation } from "../../../../src/renderer/board/use-confirmation";

afterEach(cleanup);

test("confirmation waits for main; cancellation and unmount disarm and unsubscribe", async () => {
  let receive: (arm: ArmedConfirmation | null) => void = () => undefined;
  const off = vi.fn();
  const confirm = vi.fn(() => Promise.resolve());
  const cancel = vi.fn(() => Promise.resolve());
  const client: ConfirmationClient = {
    subscribe(callback) {
      receive = callback;
      return off;
    },
    confirm,
    cancel,
  };
  const operation = Promise.withResolvers<undefined>();
  const action = vi.fn(() => operation.promise);
  const done = vi.fn();
  const view = renderHook(() => useConfirmation(client));
  const arm = { nonce: "n", target: "t", label: "Click again" };
  act(() => {
    receive(arm);
    view.result.current.cancel();
  });
  expect(view.result.current.arm).toBeNull();
  expect(cancel).not.toHaveBeenCalled();
  act(() => {
    void view.result.current.run(action, done);
    void view.result.current.run(action, done);
  });
  expect(action).toHaveBeenCalledOnce();
  expect(view.result.current.pending).toBe(true);
  act(() => {
    receive(arm);
  });
  expect(view.result.current.arm).toEqual(arm);
  await act(async () => {
    await view.result.current.run(action, done);
  });
  expect(confirm).toHaveBeenCalledWith(arm);
  act(() => {
    view.result.current.cancel();
    receive(null);
  });
  expect(view.result.current.arm).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
  view.unmount();
  expect(cancel).toHaveBeenCalledTimes(2);
  expect(off).toHaveBeenCalledOnce();
  await act(async () => {
    operation.resolve(undefined);
    await operation.promise;
  });
  expect(done).not.toHaveBeenCalled();
});

test("optional confirmation support completes ordinary actions", async () => {
  const action = vi.fn(() => Promise.resolve());
  const done = vi.fn();
  const view = renderHook(() => useConfirmation(undefined));
  await act(async () => {
    await view.result.current.run(action, done);
  });
  expect(action).toHaveBeenCalledOnce();
  expect(done).toHaveBeenCalledOnce();
  expect(view.result.current.pending).toBe(false);
});

test("overlapping launchers confirm and cancel only their own operation", async () => {
  const listeners = new Set<(arm: ArmedConfirmation | null, accepted?: boolean) => void>();
  const cancel = vi.fn(() => Promise.resolve());
  const confirm = vi.fn(() => Promise.resolve());
  const client: ConfirmationClient = {
    subscribe(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    confirm,
    cancel,
  };
  const first = Promise.withResolvers<undefined>();
  const second = Promise.withResolvers<undefined>();
  const oldView = renderHook(() => useConfirmation(client));
  const newView = renderHook(() => useConfirmation(client));
  const emit = (arm: ArmedConfirmation | null, accepted?: boolean) => {
    act(() => {
      for (const listener of listeners) listener(arm, accepted);
    });
  };
  act(() => {
    void oldView.result.current.run(() => first.promise);
  });
  emit({ nonce: "first", target: "first", label: "Confirm first" });
  act(() => {
    void newView.result.current.run(() => second.promise);
  });
  emit(null);
  const arm = { nonce: "second", target: "second", label: "Confirm second" };
  emit(arm);
  expect(oldView.result.current.arm).toBeNull();
  act(() => {
    oldView.result.current.cancel();
  });
  oldView.unmount();
  expect(cancel).not.toHaveBeenCalled();
  await act(async () => {
    first.resolve(undefined);
    await first.promise;
    await newView.result.current.run(vi.fn());
  });
  expect(confirm).toHaveBeenCalledWith(arm);
  emit(null, true);
  await act(async () => {
    second.resolve(undefined);
    await second.promise;
  });
  expect(newView.result.current.arm).toBeNull();
  expect(newView.result.current.pending).toBe(false);
});
