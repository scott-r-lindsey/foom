import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { AgentId } from "../../shared/agents";
import type {
  EnvironmentCandidate,
  EnvironmentChange,
  EnvironmentRow,
  EnvironmentScope,
  EnvironmentState,
  EnvironmentVariable,
} from "../../shared/environment";
import {
  ENVIRONMENT_NAME_LIMIT,
  ENVIRONMENT_ROW_LIMIT,
  ENVIRONMENT_SCOPES,
  IMPORTABLE,
  LOOPBACK,
  environmentProblem,
  foldName,
  hasUrlCredentials,
  isPathName,
  isProxyName,
  maskCredentials,
  urlCredentials,
} from "../../shared/environment-rules";

/** OS-backed encryption for secret values (Electron `safeStorage` in the app). */
export interface SecretCipher {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

/** Linux without a keyring falls back to a fixed key; that is not a secret store. */
export function safeStorageCipher(storage: {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?: () => string;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
}): SecretCipher {
  return {
    available: () =>
      storage.isEncryptionAvailable() &&
      (process.platform !== "linux" || storage.getSelectedStorageBackend?.() !== "basic_text"),
    encrypt: (text) => storage.encryptString(text),
    decrypt: (data) => storage.decryptString(data),
  };
}

interface Row {
  name: string;
  value: string;
  secret: boolean;
}
type Lists = Record<EnvironmentScope, Row[]>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scope(value: unknown): EnvironmentScope {
  if (typeof value !== "string" || !(ENVIRONMENT_SCOPES as readonly string[]).includes(value))
    throw new Error("Invalid environment list");
  return value as EnvironmentScope;
}

function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length > limit) throw new Error("Invalid environment");
  return value;
}

/** Validates an untrusted change from IPC; only these fields are read. */
export function parseEnvironmentChange(value: unknown): EnvironmentChange {
  if (!record(value)) throw new Error("Invalid environment");
  const keys = Object.keys(value).sort().join();
  if (keys !== "name,previous,scope,secret,value") throw new Error("Invalid environment");
  if (typeof value["secret"] !== "boolean") throw new Error("Invalid environment");
  return {
    scope: scope(value["scope"]),
    previous: value["previous"] === null ? null : text(value["previous"], ENVIRONMENT_NAME_LIMIT),
    name: text(value["name"], ENVIRONMENT_NAME_LIMIT),
    // Over-long values reach the shared rule and get its reason.
    value: value["value"] === null ? null : text(value["value"], 1 << 20),
    secret: value["secret"],
  };
}

const execute = promisify(execFile);

/**
 * Reads only the importable variables from the login shell: a fixed program with NUL
 * delimiters, no interpolated names or paths. Windows has no login shell; it reads the
 * environment Foom inherited from the desktop session.
 */
export async function loginEnvironment(
  run: (
    file: string,
    args: readonly string[],
    options: { encoding: "utf8"; timeout: number; maxBuffer: number; cwd: string },
  ) => Promise<{ stdout: string }> = execute,
  platform: NodeJS.Platform = process.platform,
  inherited: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  if (platform === "win32") {
    for (const name of IMPORTABLE) {
      const key = Object.keys(inherited).find(
        (entry) => entry.toUpperCase() === name.toUpperCase(),
      );
      const value = key === undefined ? undefined : inherited[key];
      if (value) values[name.toUpperCase()] = value;
    }
    return values;
  }
  const shell = userInfo().shell;
  if (!shell || !isAbsolute(shell)) throw new Error("No login shell");
  const program = `printf "\\000FOOM_ENV${"\\000%s".repeat(IMPORTABLE.length)}\\000" ${IMPORTABLE.map((name) => `"$${name}"`).join(" ")}`;
  const { stdout } = await run(shell, ["-ilc", program], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 256 * 1024,
    cwd: homedir(),
  });
  const fields = stdout.split("\0FOOM_ENV\0")[1]?.split("\0");
  if (!fields || fields.length < IMPORTABLE.length) throw new Error("Unreadable login shell");
  IMPORTABLE.forEach((name, index) => {
    const value = fields[index];
    if (value) values[name] = value;
  });
  return values;
}

/**
 * The environment the terminal host passes on before layers: Foom's own process
 * environment without npm, Electron, Foom and parent-agent variables.
 */
export function inheritedEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env))
    if (value !== undefined && !/^(npm_|ELECTRON_|FOOM_|CLAUDECODE$)/i.test(key))
      result[key] = value;
  return result;
}

export interface LaunchEnvironment {
  /** Variables for the terminal spec, over the inherited environment. */
  env: Record<string, string>;
  /** Names Foom set from Environment settings and the loopback bypass. Never values. */
  names: string[];
}

/**
 * Layers, each overriding the previous: the inherited (scrubbed) environment, then each
 * of `layers` in order, then `foom`, which no layer can override. PATH entries only
 * prepend, later layers first. With any proxy set, NO_PROXY and no_proxy keep every
 * existing entry and gain the loopback addresses. Every variable is validated again.
 */
export function buildLaunchEnvironment({
  layers,
  base,
  path,
  pathFirst,
  foom = {},
  windows = process.platform === "win32",
}: {
  layers: readonly (readonly EnvironmentVariable[])[];
  base: Readonly<Record<string, string>>;
  /** A PATH to set even without layers, such as the login shell's; inherited by default. */
  path?: string | undefined;
  /** Foom's own directories, ahead of every layer's. */
  pathFirst?: string | undefined;
  foom?: Readonly<Record<string, string>>;
  windows?: boolean;
}): LaunchEnvironment {
  const env: Record<string, string> = {};
  const names = new Set<string>();
  // Reuse the inherited spelling on Windows, so a layer replaces rather than duplicates.
  const key = (name: string) =>
    windows
      ? (Object.keys(env).find((entry) => foldName(entry, true) === foldName(name, true)) ??
        Object.keys(base).find((entry) => foldName(entry, true) === foldName(name, true)) ??
        name)
      : name;
  const prefixes: string[] = [];
  for (const layer of layers) {
    const prefix: string[] = [];
    for (const { name, value } of layer) {
      const problem = environmentProblem(name, value, windows);
      if (problem) throw new Error(problem);
      if (isPathName(name)) prefix.push(value);
      else env[key(name)] = value;
      names.add(key(name));
    }
    prefixes.unshift(...prefix);
  }
  if (pathFirst) prefixes.unshift(pathFirst);
  const tail = path ?? base[key("PATH")];
  if (prefixes.length)
    env[key("PATH")] = [...prefixes, ...(tail ? [tail] : [])].join(windows ? ";" : ":");
  else if (path !== undefined) env[key("PATH")] = path;
  const merged = { ...base, ...env };
  const values = (test: (name: string) => boolean) =>
    Object.entries(merged)
      .filter(([name]) => test(name))
      .map(([, value]) => value);
  if (values(isProxyName).some((value) => value !== "")) {
    const entries: string[] = [];
    for (const value of values((name) => name.toLowerCase() === "no_proxy"))
      for (const entry of value.split(",").map((part) => part.trim()))
        if (entry && !entries.includes(entry)) entries.push(entry);
    for (const entry of LOOPBACK) if (!entries.includes(entry)) entries.push(entry);
    for (const name of windows ? ["NO_PROXY"] : ["NO_PROXY", "no_proxy"]) {
      env[key(name)] = entries.join(",");
      names.add(key(name));
    }
  }
  return { env: { ...env, ...foom }, names: [...names] };
}

/**
 * Environment settings in `environment.json` in user data, outside `settings.json`.
 * Secret values are stored only as `safeStorage` ciphertext and never leave main.
 */
export class EnvironmentStore {
  private lists: Lists = { all: [], claude: [], codex: [], agy: [] };
  private pending: Promise<void> = Promise.resolve();
  private candidates = new Map<string, string>();

  private constructor(
    private readonly file: string,
    private readonly cipher: SecretCipher,
    private readonly windows: boolean,
    private readonly read: () => Promise<Record<string, string>>,
  ) {}

  /** Invalid rows and secrets that can no longer be decrypted are dropped. */
  static async open(
    userData: string,
    cipher: SecretCipher,
    {
      windows = process.platform === "win32",
      read = () => loginEnvironment(),
    }: { windows?: boolean; read?: () => Promise<Record<string, string>> } = {},
  ): Promise<EnvironmentStore> {
    const store = new EnvironmentStore(join(userData, "environment.json"), cipher, windows, read);
    let state: unknown;
    try {
      state = JSON.parse(await readFile(store.file, "utf8"));
    } catch {
      return store;
    }
    if (!record(state) || state["version"] !== 1 || !record(state["lists"])) return store;
    for (const id of ENVIRONMENT_SCOPES) {
      const rows = state["lists"][id];
      if (!Array.isArray(rows)) continue;
      for (const row of rows.slice(0, ENVIRONMENT_ROW_LIMIT)) {
        if (!record(row) || typeof row["name"] !== "string") continue;
        let value: string;
        const secret = row["secret"] === true;
        try {
          if (secret) {
            if (typeof row["cipher"] !== "string" || !cipher.available()) continue;
            value = cipher.decrypt(Buffer.from(row["cipher"], "base64"));
          } else if (typeof row["value"] === "string") value = row["value"];
          else continue;
        } catch {
          continue;
        }
        const name = row["name"];
        if (
          environmentProblem(name, value, windows) ||
          (!secret && hasUrlCredentials(value)) ||
          store.lists[id].some((other) => foldName(other.name, windows) === foldName(name, windows))
        )
          continue;
        store.lists[id].push({ name, value, secret });
      }
    }
    return store;
  }

  state(): EnvironmentState {
    const lists = {} as Record<EnvironmentScope, readonly EnvironmentRow[]>;
    for (const id of ENVIRONMENT_SCOPES)
      lists[id] = this.lists[id].map((row) => ({
        name: row.name,
        value: row.secret ? null : row.value,
        secret: row.secret,
      }));
    return { lists, windows: this.windows, secrets: this.cipher.available() };
  }

  /** The layers for a launch: All sessions, then the agent's own. Shells get All only. */
  layers(target: AgentId | "shell"): readonly (readonly EnvironmentVariable[])[] {
    const copy = (rows: Row[]) => rows.map(({ name, value }) => ({ name, value }));
    return target === "shell"
      ? [copy(this.lists.all)]
      : [copy(this.lists.all), copy(this.lists[target])];
  }

  /** Secret values and URL credentials, for terminal-tail redaction. */
  redactions(): string[] {
    const values = new Set<string>();
    for (const id of ENVIRONMENT_SCOPES)
      for (const row of this.lists[id]) {
        if (row.secret && row.value) values.add(row.value);
        const credentials = urlCredentials(row.value);
        if (credentials) {
          // A user name alone may be a token; with a password, only the password is secret.
          const separator = credentials.indexOf(":");
          const secret = separator < 0 ? credentials : credentials.slice(separator + 1);
          values.add(credentials);
          if (secret) values.add(secret);
          try {
            const decoded = decodeURIComponent(secret);
            if (decoded) values.add(decoded);
          } catch {
            // Malformed escapes: the raw value is already listed.
          }
        }
      }
    return [...values];
  }

  async save(input: unknown): Promise<EnvironmentState> {
    const change = parseEnvironmentChange(input);
    return this.write((lists) => {
      const rows = lists[change.scope];
      const fold = (name: string) => foldName(name, this.windows);
      const index =
        change.previous === null
          ? -1
          : rows.findIndex((row) => fold(row.name) === fold(change.previous ?? ""));
      if (change.previous !== null && index < 0)
        throw new Error(`${change.previous} is no longer in this list`);
      if (index < 0 && rows.length >= ENVIRONMENT_ROW_LIMIT)
        throw new Error("Lists hold at most 64 variables");
      if (rows.some((row, other) => other !== index && fold(row.name) === fold(change.name)))
        throw new Error(`${change.name} is already in this list`);
      const existing = rows[index];
      let value: string;
      if (change.value !== null) value = change.value;
      else if (existing?.secret && change.secret) value = existing.value;
      else throw new Error("Enter a value");
      const problem = environmentProblem(change.name, value, this.windows);
      if (problem) throw new Error(problem);
      const row = {
        name: change.name,
        value,
        secret: change.secret || hasUrlCredentials(value),
      };
      if (index < 0) rows.push(row);
      else rows[index] = row;
    });
  }

  async remove(scopeValue: unknown, nameValue: unknown): Promise<EnvironmentState> {
    const id = scope(scopeValue);
    const name = text(nameValue, ENVIRONMENT_NAME_LIMIT);
    return this.write((lists) => {
      lists[id] = lists[id].filter(
        (row) => foldName(row.name, this.windows) !== foldName(name, this.windows),
      );
    });
  }

  /** Offers valid importable variables; their values stay in main until imported. */
  async readShell(): Promise<EnvironmentCandidate[]> {
    let values: Record<string, string>;
    try {
      values = await this.read();
    } catch {
      throw new Error("Unable to read the login shell");
    }
    this.candidates = new Map();
    const result: EnvironmentCandidate[] = [];
    for (const name of IMPORTABLE) {
      const value = values[name];
      if (
        value === undefined ||
        environmentProblem(name, value, this.windows) ||
        [...this.candidates.keys()].some(
          (other) => foldName(other, this.windows) === foldName(name, this.windows),
        )
      )
        continue;
      this.candidates.set(name, value);
      const current = this.lists.all.find(
        (row) => foldName(row.name, this.windows) === foldName(name, this.windows),
      );
      result.push({
        name,
        // A saved secret is never shown, even when the shell holds the same value.
        display: current?.secret ? "••••••••" : maskCredentials(value),
        status: !current ? "new" : current.value === value ? "same" : "replaces",
      });
    }
    return result;
  }

  async import(input: unknown): Promise<EnvironmentState> {
    if (!Array.isArray(input) || input.length > IMPORTABLE.length)
      throw new Error("Invalid import");
    const names = input.map((name) => text(name, ENVIRONMENT_NAME_LIMIT));
    const picked = names.map((name) => {
      const value = this.candidates.get(name);
      if (value === undefined) throw new Error("Read the login shell again");
      return { name, value };
    });
    const state = await this.write((lists) => {
      for (const { name, value } of picked) {
        const fold = (entry: string) => foldName(entry, this.windows);
        const index = lists.all.findIndex((row) => fold(row.name) === fold(name));
        const secret = hasUrlCredentials(value) || lists.all[index]?.secret === true;
        if (index < 0) {
          if (lists.all.length >= ENVIRONMENT_ROW_LIMIT)
            throw new Error("Lists hold at most 64 variables");
          lists.all.push({ name, value, secret });
        } else lists.all[index] = { name, value, secret };
      }
    });
    this.candidates = new Map();
    return state;
  }

  /** Applies a change to a copy and persists it; a failure leaves the lists unchanged. */
  private async write(change: (lists: Lists) => void): Promise<EnvironmentState> {
    const write = this.pending
      .catch(() => undefined)
      .then(async () => {
        const next = {} as Lists;
        for (const id of ENVIRONMENT_SCOPES) next[id] = this.lists[id].map((row) => ({ ...row }));
        change(next);
        if (
          ENVIRONMENT_SCOPES.some((id) => next[id].some((row) => row.secret)) &&
          !this.cipher.available()
        )
          throw new Error("Secrets need the system keychain, which is unavailable");
        const stored = {} as Record<EnvironmentScope, unknown[]>;
        for (const id of ENVIRONMENT_SCOPES)
          stored[id] = next[id].map((row) =>
            row.secret
              ? {
                  name: row.name,
                  secret: true,
                  cipher: this.cipher.encrypt(row.value).toString("base64"),
                }
              : { name: row.name, value: row.value },
          );
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify({ version: 1, lists: stored }), {
            flag: "wx",
            mode: 0o600,
          });
          await rename(temporary, this.file);
        } finally {
          await rm(temporary, { force: true });
        }
        this.lists = next;
      });
    this.pending = write;
    await write;
    return this.state();
  }
}
