import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ShellState, TerminalSpec } from "../shared/desktop";

/** Private startup file; user profiles and global shell configuration are never edited. */
export function prepareShell(spec: TerminalSpec):
  | {
      args: readonly string[];
      parse(data: string): ShellState | undefined;
      dispose(): void;
    }
  | undefined {
  if (!spec.shellIntegration || basename(spec.command) !== "bash") return undefined;
  const directory = mkdtempSync(join(tmpdir(), "foom-shell-"));
  const file = join(directory, "bashrc");
  const token = randomUUID();
  try {
    writeFileSync(
      file,
      String.raw`
# Load the same profiles as the login shell Foom normally starts.
[[ -r /etc/profile ]] && source /etc/profile
for _foom_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [[ -r $_foom_profile ]]; then source "$_foom_profile"; break; fi
done
unset _foom_profile
# PS0 was introduced in Bash 4.4. Older shells retain normal output detection.
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
  _foom_prompt() {
    local _foom_status=$?
    builtin printf '\033]633;${token};prompt;%s\007' "$_foom_status"
    return "$_foom_status"
  }
  PROMPT_COMMAND=(_foom_prompt "` +
        "${PROMPT_COMMAND[@]}" +
        String.raw`")
  PS0='\e]633;${token};running\a'"` +
        "${PS0-}" +
        String.raw`"
fi
`,
      { mode: 0o600 },
    );
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    args: ["--rcfile", file, "-i"],
    parse(data) {
      if (data === `${token};running`) return { phase: "running" };
      const prefix = `${token};prompt;`;
      if (!data.startsWith(prefix)) return undefined;
      const code = data.slice(prefix.length);
      if (!/^\d{1,3}$/.test(code) || Number(code) > 255) return undefined;
      return { phase: "prompt", exitCode: Number(code) };
    },
    dispose() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
