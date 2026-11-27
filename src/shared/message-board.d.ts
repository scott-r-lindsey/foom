export type ThreadState = "open" | "waiting-repo" | "waiting-human" | "resolved";
export type PostKind = "request" | "answer" | "decision-needed" | "fyi" | "link" | "question";
export interface DecisionSubject {
  pullRequest: number;
  headSha: string;
}
export interface DecisionQuestion {
  title: string;
  detail?: string;
  options: { id: string; label: string; hint?: string }[];
  preview?: { path: string; relativeTo?: "repository" | "worktree" };
  subject?: DecisionSubject;
}
export type DecisionChoice = { option: string; other?: never } | { option?: never; other: string };
export type DecisionAddress = { post: string; index: number };
export type DecisionAnswer = DecisionAddress & DecisionChoice;
export type DecisionStatus = "open" | "checking" | "stale" | "withdrawn" | "answered";
export interface BoardDecision extends DecisionAddress {
  repository: string;
  question: DecisionQuestion;
  status: DecisionStatus;
  /** Main-authored dispatcher launch grant. Only a fixed option is accepted. */
  grant?: true;
  movedHead?: string;
  checks?: "success" | "pending" | "failure" | "none" | "unknown";
}
export interface BoardDecisions {
  counts: Record<string, number>;
  orchestrators?: Record<string, string>;
  questions: BoardDecision[];
}
export interface BoardAnswerBatch {
  answers: DecisionAnswer[];
  idempotencyKey: string;
}
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
  questions?: DecisionQuestion[];
  withdrawn?: true;
  stale?: number[];
  staleHeads?: Record<string, string>;
  previewWorktree?: string;
  decisions?: BoardDecision[];
  answers?: (DecisionAnswer & { subject?: DecisionSubject })[];
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
  questions?: DecisionQuestion[];
}
export interface BoardMutation {
  thread: string;
  post: string | null;
}
export interface MessageBoardApi {
  decisions?: (query: { repository?: string; watch: DecisionAddress[] }) => Promise<BoardDecisions>;
  answer?: (input: BoardAnswerBatch) => Promise<BoardMutation>;
  preview?: (input: DecisionAddress) => Promise<string | null>;
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
