import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { codexApprovals } from "../../../../src/terminal-host/remote/codex-approvals";

test.skipIf(process.platform === "win32")(
  "reads bounded remote account defaults and returns only a closed observation",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-approvals-"));
    const directory = join(home, ".codex");
    const config = join(directory, "config.toml");
    try {
      await expect(codexApprovals(home, {})).resolves.toBe("may-prompt");
      await mkdir(directory);
      for (const [source, expected] of [
        ['approval_policy = "never"', "disabled"],
        ['approval_policy = "on-request"\nsandbox_mode = "workspace-write"', "may-prompt"],
        ['approval_policy = "on-failure"', "may-prompt"],
        ['approval_policy = "untrusted"', "may-prompt"],
        ['model = "example"', "may-prompt"],
        [
          "[approval_policy.granular]\nsandbox_approval = true\nrules = false\nmcp_elicitations = false",
          "may-prompt",
        ],
        [
          "[approval_policy.granular]\nsandbox_approval = false\nrules = false\nmcp_elicitations = false\nrequest_permissions = true",
          "may-prompt",
        ],
        [
          '[approval_policy.granular]\nsandbox_approval = true\nrules = "not a boolean"\nmcp_elicitations = false',
          "unknown",
        ],
        [
          '[approval_policy.granular]\nsandbox_approval = true\nrules = false\nmcp_elicitations = false\nskill_approval = "not a boolean"',
          "unknown",
        ],
        ["[approval_policy.granular]\nsandbox_approval = true", "unknown"],
        [
          "[approval_policy.granular]\nsandbox_approval = false\nrules = false\nmcp_elicitations = false\nfuture_field = true",
          "unknown",
        ],
        [
          "[approval_policy]\nother = true\n[approval_policy.granular]\nsandbox_approval = true\nrules = false\nmcp_elicitations = false",
          "unknown",
        ],
        ["[approval_policy.granular]\nsandbox_approval = false", "unknown"],
        ['approval_policy = "unsupported"', "unknown"],
        ['profile = "other"', "unknown"],
        ['approvals_reviewer = "auto_review"', "unknown"],
        ["[invalid-toml", "unknown"],
        [" ".repeat(64 * 1024 + 1), "unknown"],
      ] as const) {
        await writeFile(config, source);
        await expect(codexApprovals(home, {})).resolves.toBe(expected);
      }
      const custom = join(home, "custom");
      await mkdir(custom);
      await writeFile(join(custom, "config.toml"), 'approval_policy = "never"');
      await expect(codexApprovals(home, { CODEX_HOME: "relative" })).resolves.toBe("unknown");
      await expect(codexApprovals(home, { CODEX_HOME: custom })).resolves.toBe("disabled");
      await rm(config);
      await symlink(join(custom, "config.toml"), config);
      await expect(codexApprovals(home, {})).resolves.toBe("unknown");
      await rm(config);
      await mkdir(config);
      await expect(codexApprovals(home, {})).resolves.toBe("unknown");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
