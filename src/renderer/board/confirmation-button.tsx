import type { ReactNode } from "react";
import type { ConfirmationClient } from "../../shared/confirmation";
import { useConfirmation } from "./use-confirmation";
export function ConfirmationButton({
  client,
  action,
  children,
}: {
  client: ConfirmationClient | undefined;
  action: () => Promise<void>;
  children: ReactNode;
}) {
  const confirmation = useConfirmation(client);
  return (
    <button
      type="button"
      data-armed={Boolean(confirmation.arm) || undefined}
      onPointerLeave={confirmation.cancel}
      onBlur={confirmation.cancel}
      onKeyDown={(event) => {
        if (event.key === "Escape") confirmation.cancel();
      }}
      onClick={() => {
        void confirmation.run(action);
      }}
    >
      {confirmation.arm?.label ?? children}
    </button>
  );
}
