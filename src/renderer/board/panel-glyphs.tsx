import { AgentBadge } from "./agent-badge";

/** Command glyphs say what a command does; paths match docs/mockups/sidebar-panels.html. */
const commandPaths = {
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5M7 7v4M9 7v4" />,
  stop: <rect className="glyph-solid" x="4.5" y="4.5" width="7" height="7" rx="1.2" />,
  close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  unlist: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.5 8h5" />
    </>
  ),
  restart: <path d="M12.5 8a4.5 4.5 0 1 1-1.4-3.3M11.5 2.5v2.5H9" />,
  resume: <path className="glyph-solid" d="M5.5 3.8l6.2 4.2-6.2 4.2z" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  copy: <path d="M5.5 5.5h7v7h-7zM3.5 10.5v-7h7" />,
  branch: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5" r="1.5" />
      <path d="M4.5 5v6M11.5 6.5c0 2.6-4 2.3-6.4 4.6" />
    </>
  ),
  pin: <path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5" />,
};
export type CommandGlyphName = keyof typeof commandPaths;

export function CommandGlyph({ name }: { name: CommandGlyphName | undefined }) {
  return (
    <span className="command-glyph" aria-hidden="true">
      {name && <svg viewBox="0 0 16 16">{commandPaths[name]}</svg>}
    </span>
  );
}

/** Location marks reuse the sidebar row icons; sessions and the home shell use their badge. */
const locationPaths = {
  repository: <path d="M2 2.5h8v7H2zM2 5h8" />,
  checkout: <path d="M1.5 3h3.2l1 1.2h4.8v5.3h-9z" />,
  worktree: (
    <>
      <circle cx="3" cy="2.5" r="1.3" />
      <circle cx="3" cy="9.5" r="1.3" />
      <circle cx="9" cy="4" r="1.3" />
      <path d="M3 3.8v4.4M9 5.3c0 2-3 1.7-5.6 3.3" />
    </>
  ),
  detached: (
    <>
      <circle cx="6" cy="6" r="2.2" />
      <path d="M.5 6h3.3M8.2 6h3.3" />
    </>
  ),
};
export type LocationMark = keyof typeof locationPaths;
const isLocation = (mark: string): mark is LocationMark => Object.hasOwn(locationPaths, mark);

export function PanelMark({ mark }: { mark: string }) {
  return (
    <span className="panel-mark" aria-hidden="true">
      {isLocation(mark) ? (
        <svg viewBox="0 0 12 12">{locationPaths[mark]}</svg>
      ) : (
        <AgentBadge mark={mark} />
      )}
    </span>
  );
}
