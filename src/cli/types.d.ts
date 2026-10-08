export interface Connection {
  endpoint: string;
  instanceId: string;
  token: string;
}
export interface ConsoleIo {
  out: (text: string) => void;
  error: (text: string) => void;
  input: AsyncIterable<string | Buffer>;
}
export interface Command {
  method: string;
  params: Record<string, unknown>;
}
