// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { AgentBadge } from "../../../../src/renderer/board/agent-badge";

afterEach(cleanup);
test.each([undefined, "", "CC", "CX", "AG", ">_", "New agent"])(
  "renders %s as inert text with an unknown fallback",
  (mark) => {
    const { container } = render(<AgentBadge mark={mark} />);
    expect(container.textContent).toBe(mark || "?");
    expect(container.querySelector("img, svg, object, iframe")).toBeNull();
  },
);
