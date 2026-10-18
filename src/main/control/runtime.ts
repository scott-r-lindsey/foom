import type { McpConnection, WorkspaceTerminal } from "../../shared/workspace";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { PreviewBroker } from "./previews";
import type { PreviewBackend } from "./previews";
import { ControlService } from "./service";
import { ControlHttp } from "./http";
import { Operations } from "./operations";
import { ControlStore } from "./store";
import { atomicPrivate, privateDirectory } from "../../node-common/private-files";
import type { Orchestration } from "./orchestration";
import type { ControlLaunch, PairingOptions, Role } from "./types";

/** Lazy app-owned endpoint. Startup failure never leaves published credentials or a listener. */
export class ControlRuntime {
  private constructor(
    private readonly directory: string,
    readonly service: ControlService,
    private readonly http: ControlHttp,
    readonly audit: ControlStore,
  ) {}
  static async start(
    userData: string,
    source?: () => readonly WorkspaceTerminal[],
    pairing?: PairingOptions,
    orchestration?: Pick<Orchestration, "call">,
    connectionChanged?: (id: string, state: McpConnection | undefined) => void,
    auditChanged?: () => void,
    previews?: PreviewBackend,
  ): Promise<ControlRuntime> {
    const directory = await privateDirectory(userData);
    const store = new ControlStore(directory, auditChanged);
    // Recovery is batched and completes before any request or fresh grant can observe the store.
    await store.recover();
    const operations = new Operations(
      (record) => store.persist(record),
      (actor) => {
        service.assertActive(actor);
      },
    );
    const service = new ControlService(
      operations,
      source,
      orchestration,
      connectionChanged,
      (actor, method, status, target) => store.refused(actor, method, status, target),
      previews
        ? new PreviewBroker(
            previews,
            (event) => store.preview(event),
            (actor) => {
              service.assertActive(actor);
            },
            undefined,
            undefined,
            auditChanged,
          )
        : undefined,
    );
    const http = await ControlHttp.listen(service, pairing);
    try {
      await atomicPrivate(directory, "discovery.json", {
        version: 1,
        endpoint: http.endpoint,
        instanceId: service.instanceId,
      });
      return new ControlRuntime(directory, service, http, store);
    } catch (error) {
      await http.close();
      throw error;
    }
  }
  /** Roles come from main only: a restored orchestrator, or a child naming its parent. */
  prepare(
    repository: string,
    worktree: string,
    sessionId?: string,
    role: Exclude<Role, "cli"> = "agent",
    parentId: string | null = null,
  ): ControlLaunch {
    const launch = this.service.prepare(repository, worktree, role, parentId, sessionId);
    return {
      ...launch,
      env: {
        ...launch.env,
        FOOM_CONTROL_URL: this.http.endpoint,
        FOOM_CLI_DIRECTORY: join(__dirname, "../../console").replace(
          "app.asar",
          "app.asar.unpacked",
        ),
      },
    };
  }
  /** The human's elevate or revoke for a running session; see ControlService.setRole. */
  setRole(terminalId: string, role: "agent" | "orchestrator"): void {
    this.service.setRole(terminalId, role);
  }
  takeOver(id: string): void {
    this.service.takeOver(id);
  }
  async close(): Promise<void> {
    await this.http.close();
    await rm(join(this.directory, "discovery.json"), { force: true });
  }
}
