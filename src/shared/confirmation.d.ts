import type { CleanupDialog, CleanupFeed } from "./cleanup";
import type { InterfaceTheme } from "./interface-theme";
export interface ArmedConfirmation {
  nonce: string;
  target: string;
  label: string;
}
export interface ConfirmationClient {
  onScrim?(callback: (visible: boolean) => void): () => void;
  onDialog?(callback: () => void): () => void;
  subscribe(callback: (arm: ArmedConfirmation | null, accepted?: boolean) => void): () => void;
  confirm(arm: ArmedConfirmation): Promise<void>;
  cancel(): Promise<void>;
}
export interface DialogContent {
  reply?: { context: string; text: string };
  cleanup?: CleanupDialog;
  /** Main-only; stripped before rendering. */
  feed?: CleanupFeed;
  title: string;
  accept: string;
  cancel?: "Not now";
  detail?: string;
  quiet?: string;
  subject?: string;
  glyph?: "trash" | "branch" | "power" | "orbit" | "link" | "shield" | "bell";
  note?: string;
  sections?: readonly { label: string; items: readonly string[] }[];
  facts?: readonly { label: string; value: string; mono?: boolean }[];
  arguments?: readonly string[];
  pairing?: { code: string; expiresAt: number };
  worktrees?: readonly { branch: string; reason?: string }[];
  changes?: string;
  sessions?: readonly { id: string; name: string; location: string; state: string }[];
}
export interface DialogRequest extends Omit<DialogContent, "feed"> {
  id: string;
  theme: InterfaceTheme;
}
export interface ConfirmationWindowApi {
  render(callback: (request: DialogRequest | null) => void): () => void;
  size(value: { width: number; height: number }): void;
  answer(id: string, accepted: boolean): void;
}

/** Main-only requests: click-again is misclick protection, not a trust boundary. */
export type WorkspaceConfirmation =
  | { kind: "remove" | "stop" | "shared-agent" | "notifier" }
  | {
      kind: "merged-worktrees";
      feed?: CleanupFeed;
      worktrees: readonly { branch: string; reason?: string }[];
      subject?: string;
    }
  | { kind: "dirty-worktree"; title: string; branch?: string; changes: string }
  | {
      kind: "orchestrator";
      agent: "claude" | "codex" | "agy";
      subject?: string;
      replacing?: string;
    };
export type ConfirmWorkspace = (request: WorkspaceConfirmation) => Promise<boolean>;
