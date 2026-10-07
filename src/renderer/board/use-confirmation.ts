import { useEffect, useRef, useState } from "react";
import type { ArmedConfirmation, ConfirmationClient } from "../../shared/confirmation";
const owners = new WeakMap<ConfirmationClient, object>();
/** View state only: main owns the deadline and decision. */
export function useConfirmation(client: ConfirmationClient | undefined) {
  const [arm, setArm] = useState<ArmedConfirmation | null>(null);
  const [pending, setPending] = useState(false);
  const active = useRef(false);
  const cancelled = useRef(false);
  const hasArm = useRef(false);
  useEffect(() => {
    const unsubscribe = client?.subscribe((next, accepted) => {
      if (active.current && owners.get(client) !== active) {
        cancelled.current = true;
        hasArm.current = false;
        setArm(null);
        return;
      }
      if (active.current) {
        if (next === null && !hasArm.current) return;
        hasArm.current = next !== null;
        if (next === null && accepted !== true) cancelled.current = true;
        setArm(next);
      }
    });
    return () => {
      unsubscribe?.();
      if (client && owners.get(client) === active) {
        void client.cancel();
        owners.delete(client);
      }
      active.current = false;
    };
  }, [client]);
  const cancel = () => {
    if (!active.current) return;
    cancelled.current = true;
    setArm(null);
    if (client && owners.get(client) === active) void client.cancel();
  };
  const isCancelled = () =>
    cancelled.current || (client !== undefined && owners.get(client) !== active);
  const run = async (action: () => void | Promise<void>, done?: () => void) => {
    if (arm) {
      await client?.confirm(arm);
      return;
    }
    if (active.current) return;
    active.current = true;
    if (client) owners.set(client, active);
    hasArm.current = false;
    cancelled.current = false;
    setPending(true);
    try {
      const result = action();
      if (result) await result;
      if (!isCancelled()) done?.();
    } finally {
      if (client && owners.get(client) === active) owners.delete(client);
      active.current = false;
      setPending(false);
      setArm(null);
    }
  };
  return { arm, pending, run, cancel };
}
