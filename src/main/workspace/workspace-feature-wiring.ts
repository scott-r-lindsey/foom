import type { WorkspaceContext } from "./workspace-context";
import type {
  WorktreeLaunchContext,
  AgentSetupContext,
  SidebarCommandsContext,
  ConfigLaunchContext,
  RepositoryOperationsContext,
  OrchestrationCommandsContext,
  ExecutionEventsContext,
  OrchestrationHostContext,
} from "./workspace-capabilities";

/** Live views preserve coordinator-owned state and late-initialized owners. */
export function workspaceFeatureWiring(owner: WorkspaceContext): {
  worktreeLaunch: WorktreeLaunchContext;
  agentSetup: AgentSetupContext;
  sidebarCommands: SidebarCommandsContext;
  configLaunch: ConfigLaunchContext;
  repositoryOperations: RepositoryOperationsContext;
  orchestrationCommands: OrchestrationCommandsContext;
  executionEvents: ExecutionEventsContext;
  orchestrationHost: OrchestrationHostContext;
} {
  return {
    worktreeLaunch: {
      get addWorktree() {
        return owner.addWorktree.bind(owner);
      },
      get agents() {
        return owner.agents;
      },
      get busyWorktrees() {
        return owner.busyWorktrees;
      },
      get confirmAgentLaunch() {
        return owner.confirmAgentLaunch.bind(owner);
      },
      get defaultArguments() {
        return owner.defaultArguments;
      },
      get enabled() {
        return owner.enabled;
      },
      get executionOwner() {
        return owner.executionOwner;
      },
      get known() {
        return owner.known.bind(owner);
      },
      get launchAgent() {
        return owner.launchAgent.bind(owner);
      },
      get launched() {
        return owner.launched;
      },
      get location() {
        return owner.location;
      },
      get now() {
        return owner.now.bind(owner);
      },
      get orchestration() {
        return owner.orchestration;
      },
      get persist() {
        return owner.persist.bind(owner);
      },
      get queues() {
        return owner.queues;
      },
      get refresh() {
        return owner.refresh.bind(owner);
      },
      get replacementVersion() {
        return owner.replacementVersion.bind(owner);
      },
      get resumeStarts() {
        return owner.resumeStarts;
      },
      get scanAgents() {
        return owner.scanAgents.bind(owner);
      },
      get sessions() {
        return owner.sessions;
      },
      get shellEnvironment() {
        return owner.shellEnvironment.bind(owner);
      },
      get startExisting() {
        return owner.startExisting.bind(owner);
      },
      get startShell() {
        return owner.startShell.bind(owner);
      },
      get withRepository() {
        return owner.withRepository.bind(owner);
      },
      get worktrees() {
        return owner.worktrees.bind(owner);
      },
      deps: {
        worktrees: {
          get launchIdentity() {
            return owner.deps.worktrees.launchIdentity.bind(owner.deps.worktrees);
          },
          get listWorktrees() {
            return owner.deps.worktrees.listWorktrees.bind(owner.deps.worktrees);
          },
          get validateBranch() {
            return owner.deps.worktrees.validateBranch.bind(owner.deps.worktrees);
          },
        },
        get environment() {
          return owner.deps.environment?.bind(owner.deps);
        },
        terminals: {
          get create() {
            return owner.deps.terminals.create.bind(owner.deps.terminals);
          },
          get kill() {
            return owner.deps.terminals.kill.bind(owner.deps.terminals);
          },
        },
        get reveal() {
          return owner.deps.reveal?.bind(owner.deps);
        },
        verdicts: {
          get forget() {
            return owner.deps.verdicts.forget.bind(owner.deps.verdicts);
          },
        },
        get onChange() {
          return owner.deps.onChange?.bind(owner.deps);
        },
      },
    } satisfies WorktreeLaunchContext,
    agentSetup: {
      get agentHooks() {
        return owner.agentHooks;
      },
      get agents() {
        return owner.agents;
      },
      get agyPlugin() {
        return owner.agyPlugin;
      },
      get closed() {
        return owner.closed;
      },
      get enabled() {
        return owner.enabled;
      },
      get hooksEnabled() {
        return owner.hooksEnabled;
      },
      get launchAbort() {
        return owner.launchAbort;
      },
      get scanAgents() {
        return owner.scanAgents.bind(owner);
      },
      get scanned() {
        return owner.scanned;
      },
      set scanned(value) {
        owner.scanned = value;
      },
      get scannedProviders() {
        return owner.scannedProviders;
      },
      set scannedProviders(value) {
        owner.scannedProviders = value;
      },
      deps: {
        get agentPluginDirectory() {
          return owner.deps.agentPluginDirectory;
        },
        get pluginStagingRoot() {
          return owner.deps.pluginStagingRoot;
        },
        get onChange() {
          return owner.deps.onChange?.bind(owner.deps);
        },
        get acknowledgeAgyPluginOffer() {
          return owner.deps.acknowledgeAgyPluginOffer?.bind(owner.deps);
        },
      },
    } satisfies AgentSetupContext,
    sidebarCommands: {
      get auditHuman() {
        return owner.auditHuman.bind(owner);
      },
      get busySessions() {
        return owner.busySessions;
      },
      get busyWorktrees() {
        return owner.busyWorktrees;
      },
      get cleanup() {
        return owner.cleanup;
      },
      get closed() {
        return owner.closed;
      },
      get control() {
        return owner.control;
      },
      get executionOwner() {
        return owner.executionOwner;
      },
      get homeFacts() {
        return owner.homeFacts;
      },
      set homeFacts(value) {
        owner.homeFacts = value;
      },
      get known() {
        return owner.known.bind(owner);
      },
      get launched() {
        return owner.launched;
      },
      get makeOrchestrator() {
        return owner.makeOrchestrator.bind(owner);
      },
      get orchestration() {
        return owner.orchestration;
      },
      get refresh() {
        return owner.refresh.bind(owner);
      },
      get removeRepository() {
        return owner.removeRepository.bind(owner);
      },
      get removed() {
        return owner.removed.bind(owner);
      },
      get resumeId() {
        return owner.resumeId.bind(owner);
      },
      get revokeOrchestrator() {
        return owner.revokeOrchestrator.bind(owner);
      },
      get snapshot() {
        return owner.snapshot.bind(owner);
      },
      get startConfig() {
        return owner.startConfig.bind(owner);
      },
      get startExisting() {
        return owner.startExisting.bind(owner);
      },
      get startHomeShell() {
        return owner.startHomeShell.bind(owner);
      },
      get withRepository() {
        return owner.withRepository.bind(owner);
      },
      get worktrees() {
        return owner.worktrees.bind(owner);
      },
      deps: {
        worktrees: {
          get reviewIdentity() {
            return owner.deps.worktrees.reviewIdentity.bind(owner.deps.worktrees);
          },
          get cleanupBrokenWorktree() {
            return owner.deps.worktrees.cleanupBrokenWorktree.bind(owner.deps.worktrees);
          },
          get launchIdentity() {
            return owner.deps.worktrees.launchIdentity.bind(owner.deps.worktrees);
          },
          get listRepositories() {
            return owner.deps.worktrees.listRepositories.bind(owner.deps.worktrees);
          },
          get pruneWorktree() {
            return owner.deps.worktrees.pruneWorktree.bind(owner.deps.worktrees);
          },
        },
        get forge() {
          return owner.deps.forge;
        },
        get config() {
          return owner.deps.config;
        },
        get dialog() {
          return owner.deps.dialog;
        },
        get copyText() {
          return owner.deps.copyText?.bind(owner.deps);
        },
        get openExternal() {
          return owner.deps.openExternal?.bind(owner.deps);
        },
        terminals: {
          get kill() {
            return owner.deps.terminals.kill.bind(owner.deps.terminals);
          },
          get stop() {
            return owner.deps.terminals.stop.bind(owner.deps.terminals);
          },
        },
      },
    } satisfies SidebarCommandsContext,
    configLaunch: {
      get agents() {
        return owner.agents;
      },
      get bindConfig() {
        return owner.bindConfig.bind(owner);
      },
      get closed() {
        return owner.closed;
      },
      get configCredential() {
        return owner.configCredential.bind(owner);
      },
      get configTokens() {
        return owner.configTokens;
      },
      get defaultArguments() {
        return owner.defaultArguments;
      },
      get enabled() {
        return owner.enabled;
      },
      get ensureProbeOpen() {
        return owner.ensureProbeOpen.bind(owner);
      },
      get executionOwner() {
        return owner.executionOwner;
      },
      get input() {
        return owner.input.bind(owner);
      },
      get launched() {
        return owner.launched;
      },
      get now() {
        return owner.now.bind(owner);
      },
      get persist() {
        return owner.persist.bind(owner);
      },
      get probeHttp() {
        return owner.probeHttp;
      },
      set probeHttp(value) {
        owner.probeHttp = value;
      },
      get probeIds() {
        return owner.probeIds;
      },
      get probes() {
        return owner.probes;
      },
      set probes(value) {
        owner.probes = value;
      },
      get queues() {
        return owner.queues;
      },
      get refresh() {
        return owner.refresh.bind(owner);
      },
      get removed() {
        return owner.removed.bind(owner);
      },
      get scanAgents() {
        return owner.scanAgents.bind(owner);
      },
      get startShell() {
        return owner.startShell.bind(owner);
      },
      deps: {
        get config() {
          return owner.deps.config;
        },
        terminals: {
          get create() {
            return owner.deps.terminals.create.bind(owner.deps.terminals);
          },
          get kill() {
            return owner.deps.terminals.kill.bind(owner.deps.terminals);
          },
          get reply() {
            return owner.deps.terminals.reply?.bind(owner.deps.terminals);
          },
          get screen() {
            return owner.deps.terminals.screen?.bind(owner.deps.terminals);
          },
          get stop() {
            return owner.deps.terminals.stop.bind(owner.deps.terminals);
          },
        },
        get placeChild() {
          return owner.deps.placeChild?.bind(owner.deps);
        },
        get probeWaitingMs() {
          return owner.deps.probeWaitingMs;
        },
        verdicts: {
          get forget() {
            return owner.deps.verdicts.forget.bind(owner.deps.verdicts);
          },
        },
        get environment() {
          return owner.deps.environment?.bind(owner.deps);
        },
        get onChange() {
          return owner.deps.onChange?.bind(owner.deps);
        },
      },
    } satisfies ConfigLaunchContext,
    repositoryOperations: {
      get addWorktree() {
        return owner.addWorktree.bind(owner);
      },
      get busyWorktrees() {
        return owner.busyWorktrees;
      },
      get cleanup() {
        return owner.cleanup;
      },
      get launched() {
        return owner.launched;
      },
      get location() {
        return owner.location;
      },
      get refresh() {
        return owner.refresh.bind(owner);
      },
      get withRepository() {
        return owner.withRepository.bind(owner);
      },
      deps: {
        worktrees: {
          get createWorktree() {
            return owner.deps.worktrees.createWorktree.bind(owner.deps.worktrees);
          },
          get listWorktrees() {
            return owner.deps.worktrees.listWorktrees.bind(owner.deps.worktrees);
          },
        },
      },
    } satisfies RepositoryOperationsContext,
    orchestrationCommands: {
      get auditHuman() {
        return owner.auditHuman.bind(owner);
      },
      get busyWorktrees() {
        return owner.busyWorktrees;
      },
      get control() {
        return owner.control;
      },
      get executionOwner() {
        return owner.executionOwner;
      },
      get initializeControl() {
        return owner.initializeControl.bind(owner);
      },
      get launchAgent() {
        return owner.launchAgent.bind(owner);
      },
      get launched() {
        return owner.launched;
      },
      get location() {
        return owner.location;
      },
      get orchestration() {
        return owner.orchestration;
      },
      get queues() {
        return owner.queues;
      },
      get refresh() {
        return owner.refresh.bind(owner);
      },
      get revokeOrchestrator() {
        return owner.revokeOrchestrator.bind(owner);
      },
      get sessions() {
        return owner.sessions;
      },
      get withRepository() {
        return owner.withRepository.bind(owner);
      },
      get worktrees() {
        return owner.worktrees.bind(owner);
      },
      deps: {
        worktrees: {
          get createWorktree() {
            return owner.deps.worktrees.createWorktree.bind(owner.deps.worktrees);
          },
          get launchIdentity() {
            return owner.deps.worktrees.launchIdentity.bind(owner.deps.worktrees);
          },
          get listWorktrees() {
            return owner.deps.worktrees.listWorktrees.bind(owner.deps.worktrees);
          },
          get validateBranch() {
            return owner.deps.worktrees.validateBranch.bind(owner.deps.worktrees);
          },
        },
        terminals: {
          get kill() {
            return owner.deps.terminals.kill.bind(owner.deps.terminals);
          },
        },
        verdicts: {
          get forget() {
            return owner.deps.verdicts.forget.bind(owner.deps.verdicts);
          },
        },
      },
    } satisfies OrchestrationCommandsContext,
    executionEvents: {
      get closed() {
        return owner.closed;
      },
      get configTokens() {
        return owner.configTokens;
      },
      get executionOwner() {
        return owner.executionOwner;
      },
      get hookKeys() {
        return owner.hookKeys;
      },
      get launched() {
        return owner.launched;
      },
      get lifecycle() {
        return owner.lifecycle;
      },
      get orchestration() {
        return owner.orchestration;
      },
      get persist() {
        return owner.persist.bind(owner);
      },
      get probeIds() {
        return owner.probeIds;
      },
      get probes() {
        return owner.probes;
      },
      set probes(value) {
        owner.probes = value;
      },
      get queues() {
        return owner.queues;
      },
      get refresh() {
        return owner.refresh.bind(owner);
      },
      deps: {
        get onChange() {
          return owner.deps.onChange?.bind(owner.deps);
        },
      },
    } satisfies ExecutionEventsContext,
    orchestrationHost: {
      get launchAgent() {
        return owner.launchAgent.bind(owner);
      },
      get busyWorktrees() {
        return owner.busyWorktrees;
      },
      get cleanup() {
        return owner.cleanup;
      },
      get closed() {
        return owner.closed;
      },
      get control() {
        return owner.control;
      },
      get createChildWorktree() {
        return owner.createChildWorktree.bind(owner);
      },
      get defaultArguments() {
        return owner.defaultArguments;
      },
      get input() {
        return owner.input.bind(owner);
      },
      get launchChild() {
        return owner.launchChild.bind(owner);
      },
      get location() {
        return owner.location;
      },
      get persist() {
        return owner.persist.bind(owner);
      },
      get refresh() {
        return owner.refresh.bind(owner);
      },
      get scanAgents() {
        return owner.scanAgents.bind(owner);
      },
      get sessions() {
        return owner.sessions;
      },
      get showNewChildren() {
        return owner.showNewChildren;
      },
      get sidebarCommand() {
        return owner.sidebarCommand.bind(owner);
      },
      get snapshot() {
        return owner.snapshot.bind(owner);
      },
      get withRepository() {
        return owner.withRepository.bind(owner);
      },
      deps: {
        get hosts() {
          return owner.deps.hosts;
        },
        get forge() {
          return owner.deps.forge;
        },
        worktrees: {
          get reviewBranch() {
            return owner.deps.worktrees.reviewBranch.bind(owner.deps.worktrees);
          },
          get adoptionBranch() {
            return owner.deps.worktrees.adoptionBranch.bind(owner.deps.worktrees);
          },
          get adoptWorktree() {
            return owner.deps.worktrees.adoptWorktree.bind(owner.deps.worktrees);
          },
          get listWorktrees() {
            return owner.deps.worktrees.listWorktrees.bind(owner.deps.worktrees);
          },
          get launchIdentity() {
            return owner.deps.worktrees.launchIdentity.bind(owner.deps.worktrees);
          },
        },
        terminals: {
          get stop() {
            return owner.deps.terminals.stop.bind(owner.deps.terminals);
          },
          get childInput() {
            return owner.deps.terminals.childInput?.bind(owner.deps.terminals);
          },
          get tail() {
            return owner.deps.terminals.tail.bind(owner.deps.terminals);
          },
        },
        get placeChild() {
          return owner.deps.placeChild?.bind(owner.deps);
        },
        get reveal() {
          return owner.deps.reveal?.bind(owner.deps);
        },
        get dialog() {
          return owner.deps.dialog?.bind(owner.deps);
        },
      },
    } satisfies OrchestrationHostContext,
  };
}
