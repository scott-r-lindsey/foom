// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ArmedConfirmation, ConfirmationClient } from "../../../../src/shared/confirmation";
import { ConfirmationButton } from "../../../../src/renderer/board/confirmation-button";
afterEach(cleanup);
test("click-again delegates to main; blur, pointer exit, Escape and unmount disarm", async () => {
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
  const view = render(
    <ConfirmationButton client={client} action={action}>
      Launch
    </ConfirmationButton>,
  );
  const button = view.getByRole("button");
  const arm = { nonce: "n", target: "t", label: "Click again" };
  act(() => {
    receive(arm);
  });
  expect(button.textContent).toBe("Launch");
  fireEvent.blur(button);
  fireEvent.click(button);
  fireEvent.click(button);
  expect(action).toHaveBeenCalledOnce();
  act(() => {
    receive(arm);
  });
  expect(button.textContent).toBe("Click again");
  await act(async () => {
    fireEvent.click(button);
    await Promise.resolve();
  });
  expect(confirm).toHaveBeenCalledWith(arm);
  fireEvent.pointerLeave(button);
  expect(cancel).toHaveBeenCalledOnce();
  act(() => {
    receive(null);
  });
  expect(button.textContent).toBe("Launch");
  fireEvent.keyDown(button, { key: "x" });
  fireEvent.keyDown(button, { key: "Escape" });
  fireEvent.blur(button);
  expect(cancel).toHaveBeenCalledTimes(3);
  view.unmount();
  expect(cancel).toHaveBeenCalledTimes(4);
  expect(off).toHaveBeenCalledOnce();
  await act(async () => {
    operation.resolve(undefined);
    await operation.promise;
  });
});
test("optional confirmation support leaves ordinary actions usable", async () => {
  const action = vi.fn(() => Promise.resolve());
  const view = render(
    <ConfirmationButton client={undefined} action={action}>
      Launch
    </ConfirmationButton>,
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button"));
    await Promise.resolve();
  });
  expect(action).toHaveBeenCalledOnce();
});

test("overlapping launchers show and cancel only their own confirmation", async () => {
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
  const oldView = render(
    <ConfirmationButton client={client} action={() => first.promise}>
      First
    </ConfirmationButton>,
  );
  const newView = render(
    <ConfirmationButton client={client} action={() => second.promise}>
      Second
    </ConfirmationButton>,
  );
  const emit = (arm: ArmedConfirmation | null) => {
    act(() => {
      for (const listener of listeners) listener(arm);
    });
  };
  fireEvent.click(oldView.getByRole("button", { name: "First" }));
  emit({ nonce: "first", target: "first", label: "Confirm first" });
  fireEvent.click(newView.getByRole("button", { name: "Second" }));
  emit(null);
  const arm = { nonce: "second", target: "second", label: "Confirm second" };
  emit(arm);
  expect(oldView.getByRole("button", { name: "First" })).toBeTruthy();
  fireEvent.blur(oldView.getByRole("button", { name: "First" }));
  oldView.unmount();
  expect(cancel).not.toHaveBeenCalled();
  await act(async () => {
    first.resolve(undefined);
    await first.promise;
    fireEvent.click(newView.getByRole("button", { name: "Confirm second" }));
  });
  expect(confirm).toHaveBeenCalledWith(arm);
  await act(async () => {
    for (const listener of listeners) listener(null, true);
    second.resolve(undefined);
    await second.promise;
  });
  expect(newView.getByRole("button", { name: "Second" })).toBeTruthy();
});
