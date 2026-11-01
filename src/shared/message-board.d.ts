export type ThreadState = "open" | "waiting-repo" | "waiting-human" | "resolved";
export type PostKind = "request" | "answer" | "decision-needed" | "fyi" | "link";
export interface BoardRepository {
  id: string;
  name: string;
}
export interface MessageThread {
  id: string;
  title: string;
  repository: string;
  to: string[];
  state: ThreadState;
  createdAt: string;
  updatedAt: string;
  child?: { id: string; worktreeId: string; removedAt?: string };
}
export interface MessagePost {
  id: string;
  thread: string;
  author: "human" | `orchestrator:${string}`;
  kind: PostKind;
  text: string;
  links: string[];
  timestamp: string;
}
export interface BoardThreads {
  repositories: BoardRepository[];
  threads: MessageThread[];
  next: string | null;
  untrusted: true;
  notice: string;
}
export interface BoardRead {
  thread: MessageThread;
  posts: MessagePost[];
  next: string | null;
  untrusted: true;
  notice: string;
}
export interface BoardPostInput {
  thread?: string;
  to?: string[];
  title?: string;
  kind: PostKind;
  text: string;
  links: string[];
  idempotencyKey: string;
}
export interface BoardMutation {
  thread: string;
  post: string | null;
}
export interface MessageBoardApi {
  threads: (query: {
    repository?: string;
    category?: "topics" | "children";
    state?: ThreadState;
    after?: string;
  }) => Promise<BoardThreads>;
  read: (query: { thread: string; after?: string }) => Promise<BoardRead>;
  post: (input: BoardPostInput) => Promise<BoardMutation>;
  resolve: (input: { thread: string; idempotencyKey: string }) => Promise<BoardMutation>;
}
