// @vitest-environment jsdom
import { act } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
vi.mock("../../../src/renderer/app", () => ({ App: () => <main>Shell</main> }));
beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="root"></div>';
});
test("mounts React at the renderer root and unmounts before unload", async () => {
  await act(async () => {
    await import("../../../src/renderer/renderer");
  });
  expect(document.querySelector("main")?.textContent).toBe("Shell");
  act(() => {
    window.dispatchEvent(new Event("beforeunload"));
  });
  expect(document.querySelector("main")).toBeNull();
});
test("requires a renderer root", async () => {
  document.body.replaceChildren();
  await expect(import("../../../src/renderer/renderer")).rejects.toThrow("Missing renderer root");
});
