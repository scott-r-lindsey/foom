import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { windowIcon } from "../../../../src/main/window/app-icon";

describe("windowIcon", () => {
  it("points Linux windows at the generated 512 px icon", () => {
    expect(windowIcon("linux", "/opt/foom/build")).toEqual({
      icon: path.join("/opt/foom/build", "icons", "foom-512.png"),
    });
  });

  it("leaves macOS and Windows to their packaged bundle icons", () => {
    expect(windowIcon("darwin", "/build")).toEqual({});
    expect(windowIcon("win32", "/build")).toEqual({});
  });
});
