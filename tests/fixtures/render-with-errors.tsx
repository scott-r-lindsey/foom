import type { ReactNode } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import {
  ErrorPresentation,
  BackgroundErrorMark,
} from "../../src/renderer/board/error-presentation";

// Match the application error provider and its background failure affordance.
export const renderWithErrors = (ui: ReactNode, options?: RenderOptions) =>
  render(ui, {
    ...options,
    wrapper: ({ children }) => (
      <ErrorPresentation>
        {children}
        <BackgroundErrorMark />
      </ErrorPresentation>
    ),
  });
