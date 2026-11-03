import { expect, test } from "vitest";
import {
  REPOSITORY_PREPARATION_PROMPT,
  repositoryPreparationPrompt,
  humanPromptArguments,
} from "../../../src/shared/repository-preparation";
import { parseAgentManifest } from "../../../src/shared/agent-plugin-parser";
import claude from "../../../src/shared/bundled-agents/claude.json";
import pi from "../../../src/shared/bundled-agents/pi.json";

test("repository preparation uses fixed language-neutral guidance and quotes only the repository label", () => {
  const name = 'repo "name"\nwith $&';
  const prompt = repositoryPreparationPrompt(name);
  expect(prompt).toBe(
    REPOSITORY_PREPARATION_PROMPT.replace("{repository}", () => JSON.stringify(name)),
  );
  expect(prompt).toContain("AGENTS.md");
  expect(prompt).toContain("Ask the user before using sudo");
  expect(prompt).toContain("Report anything you could not install or configure");
  expect(prompt).not.toMatch(/Node|pnpm|Python|apt|brew|handoff|orchestrator/u);
});

test("a human prompt is one argv value after normal defaults, without child guidance or bypass flags", () => {
  const model = parseAgentManifest(JSON.stringify(claude), "bundled").model;
  const prompt = repositoryPreparationPrompt("example");
  expect(
    humanPromptArguments(model, ["--model", "user-choice"], prompt, { version: "", help: "" }),
  ).toEqual(["--model", "user-choice", "--", prompt]);
  expect(() =>
    humanPromptArguments(
      model,
      Array.from({ length: 257 }, () => "x"),
      prompt,
      { version: "", help: "" },
    ),
  ).toThrow("limits");
});

test("human prompt launch refuses unsupported CLI facts and invalid prompt values", () => {
  const model = parseAgentManifest(JSON.stringify(claude), "bundled").model;
  for (const prompt of ["", " -flag", "\u001b", "x".repeat(16385)])
    expect(() => humanPromptArguments(model, [], prompt, { version: "", help: "" })).toThrow(
      "Invalid human prompt",
    );
  expect(() =>
    humanPromptArguments(
      { ...model, launch: { ...model.launch, prompt: undefined } },
      [],
      "Prepare",
      { version: "", help: "" },
    ),
  ).toThrow("cannot take");
  expect(() =>
    humanPromptArguments(parseAgentManifest(JSON.stringify(pi), "bundled").model, [], "Prepare", {
      version: "old",
      help: "",
    }),
  ).toThrow("cannot take");
});
