import type { WorkspaceTerminal } from "../../shared/workspace";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ControlService } from "./service";
import { ControlHttp } from "./http";
import { Operations } from "./operations";
import { ControlStore } from "./store";
import { atomicPrivate, privateDirectory } from "./private-files";
import type { ControlLaunch } from "./types";

/** Lazy app-owned endpoint. Startup failure never leaves published credentials or a listener. */
export class ControlRuntime {
  private constructor(
    private readonly directory: string,
    readonly service: ControlService,
    private readonly http: ControlHttp,
  ) {}
  static async start(
    userData: string,
    source?: () => readonly WorkspaceTerminal[],
  ): Promise<ControlRuntime> {
    const directory = await privateDirectory(userData);
    const store = new ControlStore(directory);
    await store.recover();
    const operations = new Operations(
      (record) => store.persist(record),
      (actor) => {
        service.assertActive(actor);
      },
    );
    const service = new ControlService(operations, source);
    const http = await ControlHttp.listen(service);
    try {
      await atomicPrivate(directory, "discovery.json", {
        version: 1,
        endpoint: http.endpoint,
        instanceId: service.instanceId,
      });
      return new ControlRuntime(directory, service, http);
    } catch (error) {
      await http.close();
      throw error;
    }
  }
  prepare(repository: string, worktree: string, sessionId?: string): ControlLaunch {
    const launch = this.service.prepare(repository, worktree, "agent", null, sessionId);
    return { ...launch, env: { ...launch.env, FOOM_CONTROL_URL: this.http.endpoint } };
  }
  async close(): Promise<void> {
    await this.http.close();
    await rm(join(this.directory, "discovery.json"), { force: true });
  }
}
