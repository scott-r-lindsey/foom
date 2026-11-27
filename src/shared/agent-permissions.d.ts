export type AgentPermissionLevel = "ask" | "workspace" | "full";

export type AgentPermissionSettings = Readonly<
  Record<string, Readonly<Record<string, AgentPermissionChoice | null>>>
>;

export interface AgentPermissionChoice {
  level: AgentPermissionLevel;
  /** Main-owned acknowledgement of this provider's disclosure identity. */
  identity?: string;
}
