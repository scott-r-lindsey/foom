import type { BoardSource, LaunchOptions } from "./board-source.d";
import type { PanelSubject } from "./panel-facts";
import type { PanelTarget } from "./panel-intent";
import type { SidebarCommand } from "../../shared/workspace";
import type { RowAction } from "./row-menu";
import { RowMenu } from "./row-menu";
import { PanelFacts, PanelTitle } from "./panel-facts";
import { ResumeField } from "./resume-field-view";
import { BranchField } from "./branch-field-view";

export interface SidebarPanelProps {
  menu: PanelTarget;
  subject: PanelSubject;
  name: string;
  kind: string;
  mark: string;
  source: BoardSource;
  options: LaunchOptions | undefined;
  actions: (RowAction | null)[];
  rename: (value: string) => void;
  command: (command: SidebarCommand) => Promise<void>;
  created: (repository: string, path: string) => void;
  back: () => void;
  close: () => void;
  enter: () => void;
  leave: () => void;
  pin: () => void;
}
/** The parent decides when to open, pin, dismiss and restore focus. */
export function SidebarPanel({
  menu,
  subject,
  name,
  kind,
  mark,
  source,
  options,
  actions,
  rename,
  command,
  created,
  back,
  close,
  enter,
  leave,
  pin,
}: SidebarPanelProps) {
  const fieldOpen = Boolean(menu.field);
  return (
    <RowMenu
      panel={{
        title:
          subject.kind === "session" ? (
            <PanelTitle
              name={name}
              save={(value) => {
                rename(value);
              }}
            />
          ) : (
            name
          ),
        kind: kind,
        mark: mark,
        facts: (() => {
          const facts = (
            <PanelFacts key={menu.id} subject={subject} source={source} options={options} />
          );
          if (fieldOpen && subject.kind === "worktree")
            return (
              <div className="panel-side" data-field>
                {facts}
                <ResumeField
                  identities={options?.agents ?? []}
                  patterns={(options?.agents ?? [])
                    .filter((agent) => agent.path && options?.enabled[agent.id] !== false)
                    .flatMap((agent) =>
                      (agent.resumePaste ?? []).map((pattern) => ({
                        ...pattern,
                        agent: agent.id,
                      })),
                    )}
                  confirmations={source.confirmations}
                  key={`${menu.id}:resume`}
                  agents={(options?.agents ?? [])
                    .filter(
                      (agent) =>
                        agent.path &&
                        options?.enabled[agent.id] !== false &&
                        agent.resume !== false,
                    )
                    .map((agent) => agent.id)}
                  back={() => {
                    back();
                  }}
                  done={close}
                  launch={async (agent, id) => {
                    await command({
                      kind: "resume-id",
                      checkout: {
                        repository: subject.repository.path,
                        worktree: subject.tree.path,
                      },
                      agent,
                      id,
                    });
                  }}
                />
              </div>
            );
          return fieldOpen && subject.kind === "repository" && source.worktrees ? (
            <div className="panel-side" data-field>
              {facts}
              <BranchField
                key={`${menu.id}:branch`}
                repository={subject.repository.path}
                source={source.worktrees}
                back={() => {
                  back();
                }}
                created={(worktree) => {
                  created(subject.repository.path, worktree.path);
                }}
              />
            </div>
          ) : (
            facts
          );
        })(),
        pinned: menu.pinned,
        enter: () => {
          enter();
        },
        leave: () => {
          leave();
        },
        pin: () => {
          if (!menu.pinned) pin();
        },
      }}
      label={`${name} details and commands`}
      confirmations={source.confirmations}
      bottomAligned={menu.id === "config"}
      anchor={menu.anchor}
      actions={actions}
      close={close}
    />
  );
}
