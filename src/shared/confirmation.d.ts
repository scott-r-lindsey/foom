import type { InterfaceTheme } from "./interface-theme";
export interface ArmedConfirmation {
  nonce: string;
  target: string;
  label: string;
}
export interface ConfirmationClient {
  onDialog?(callback: () => void): () => void;
  subscribe(callback: (arm: ArmedConfirmation | null, accepted?: boolean) => void): () => void;
  confirm(arm: ArmedConfirmation): Promise<void>;
  cancel(): Promise<void>;
}
export interface DialogContent {
  title: string;
  accept: string;
  changes?: string;
  sessions?: readonly { id: string; name: string; location: string; state: string }[];
}
export interface DialogRequest extends DialogContent {
  id: string;
  theme: InterfaceTheme;
}
export interface ConfirmationWindowApi {
  render(callback: (request: DialogRequest | null) => void): () => void;
  answer(id: string, accepted: boolean): void;
}
