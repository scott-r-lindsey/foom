// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML =
    '<button id="hello">Say hello</button><p id="message" role="status">Ready</p>';
});

function getButton() {
  const button = document.querySelector<HTMLButtonElement>("#hello");
  if (!button) throw new Error("Missing button");
  return button;
}

function installBridge(sayHello: () => Promise<string>) {
  Object.defineProperty(window, "desktop", { configurable: true, value: { sayHello } });
}

test("disables the button while IPC is pending, displays the reply, and allows another greeting", async () => {
  const reply = Promise.withResolvers<string>();
  const sayHello = vi.fn(() => reply.promise);
  installBridge(sayHello);
  await import("../src/renderer/renderer");
  const button = getButton();
  button.click();
  expect(button.disabled).toBe(true);
  button.click();
  expect(sayHello).toHaveBeenCalledTimes(1);
  reply.resolve("Hello from the main process!");
  await vi.waitFor(() => {
    expect(button.disabled).toBe(false);
  });
  expect(document.querySelector("#message")?.textContent).toBe("Hello from the main process!");
  button.click();
  await vi.waitFor(() => {
    expect(sayHello).toHaveBeenCalledTimes(2);
  });
});

test("shows a recoverable error and reenables the button when IPC fails", async () => {
  const error = new Error("Disconnected");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  installBridge(() => Promise.reject(error));
  await import("../src/renderer/renderer");
  getButton().click();
  await vi.waitFor(() => {
    expect(getButton().disabled).toBe(false);
  });
  expect(document.querySelector("#message")?.textContent).toContain("Please try again.");
  expect(log).toHaveBeenCalledWith(error);
});

test.each(["#hello", "#message"])(
  "fails clearly when the required element %s is missing",
  async (selector) => {
    document.querySelector(selector)?.remove();
    await expect(import("../src/renderer/renderer")).rejects.toThrow(
      "Required hello world elements are missing",
    );
  },
);
