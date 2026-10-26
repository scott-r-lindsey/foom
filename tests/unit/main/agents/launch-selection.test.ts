import { describe, expect, it } from "vitest";
import {
  selectedArguments,
  selectionInput,
  validateSelection,
} from "../../../../src/node-common/launch-selection";
import { parseAgentArguments } from "../../../../src/main/agents/default-arguments";
import { bundledProviders } from "../../../../src/main/agents/providers/bundled";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import fixture from "../../../fixtures/agent-plugin.json";

describe("bounded per-child launch selections", () => {
  it.each(bundledProviders)(
    "expands or refuses the $id model using its declared argv",
    (provider) => {
      if (provider.model.launch.model) {
        expect(
          selectedArguments(provider.model, ["--other", "keep"], { model: "provider/model:v1" }),
        ).toEqual(["--other", "keep", "--model", "provider/model:v1"]);
      } else
        expect(() =>
          selectedArguments(provider.model, ["--other", "keep"], { model: "provider/model:v1" }),
        ).toThrow("unsupported");
    },
  );
  it.each(bundledProviders)("expands or refuses $id effort", (provider) => {
    if (provider.model.launch.effort) {
      expect(selectedArguments(provider.model, [], { effort: "high" })).toEqual(
        provider.id === "codex" ? ["-c", 'model_reasoning_effort="high"'] : ["--effort", "high"],
      );
    } else
      expect(() => selectedArguments(provider.model, [], { effort: "high" })).toThrow(
        "unsupported",
      );
  });
  it.each([
    null,
    7,
    {},
    "-flag",
    "white space",
    "a=b",
    "x".repeat(65),
    "",
    "new\nline",
    "trailing\n",
    "trailing\r",
    "trailing\u2028",
    "bad\0",
    "é",
    "{value}",
  ])("rejects token %j", (value) => {
    expect(() => selectionInput({ model: value })).toThrow("invalid_request");
    expect(() => selectionInput({ effort: value })).toThrow("invalid_request");
  });
  it("validates manifest enums and refuses undeclared options", () => {
    const model = parseAgentManifest(JSON.stringify(fixture)).model;
    expect(() => {
      validateSelection(model, { model: "test" });
    }).toThrow("unsupported");
    const codex = bundledProviders.find((p) => p.id === "codex");
    if (!codex) throw new Error("missing Codex");
    expect(() => selectedArguments(codex.model, [], { effort: "unknown" })).toThrow(
      "invalid_request",
    );
    expect(() => selectedArguments(codex.model, [], { model: "-unsafe" })).toThrow(
      "invalid_request",
    );
  });
  it("preserves defaults when omitted and replaces every model spelling without removing bypass", () => {
    const provider = bundledProviders.find((p) => p.id === "codex");
    if (!provider) throw new Error("missing Codex");
    const defaults = [
      "--model",
      "old",
      "-molder",
      "--model=oldest",
      "-m=older",
      "--dangerously-bypass-approvals-and-sandbox",
      "--other",
      "keep",
    ];
    expect(selectedArguments(provider.model, defaults)).toEqual(defaults);
    expect(selectedArguments(provider.model, defaults, { model: "new" })).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "--other",
      "keep",
      "--model",
      "new",
    ]);
    expect(
      selectedArguments(provider.model, ["--model", "--dangerously-bypass-approvals-and-sandbox"], {
        model: "new",
      }),
    ).toEqual(["--dangerously-bypass-approvals-and-sandbox", "--model", "new"]);
    expect(selectedArguments(provider.model, ["--model"], { model: "new" })).toEqual([
      "--model",
      "new",
    ]);
  });
  it("replaces only the exact Codex effort key across config spellings", () => {
    const provider = bundledProviders.find((p) => p.id === "codex");
    if (!provider) throw new Error("missing Codex");
    const defaults = [
      "-c",
      'model_reasoning_effort="low"',
      "--config=model_reasoning_effort='medium'",
      "-cmodel_reasoning_effort='high'",
      "-c='model_reasoning_effort'=\"low\"",
      "--config",
      " model_reasoning_effort = 'low'",
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      "other=keep",
      "--config",
      "nested.model_reasoning_effort=low",
      "--config",
      "model_reasoning_effortX",
      "--config",
    ];
    expect(selectedArguments(provider.model, defaults, { effort: "xhigh" })).toEqual([
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      "other=keep",
      "--config",
      "nested.model_reasoning_effort=low",
      "--config",
      "model_reasoning_effortX",
      "--config",
      "-c",
      'model_reasoning_effort="xhigh"',
    ]);
  });
  it("accepts a declared model allowlist and rejects values outside it", () => {
    const data = {
      ...fixture,
      launch: {
        ...fixture.launch,
        model: { flags: ["--model"], arguments: ["--model", "{value}"], values: ["allowed"] },
      },
    };
    const manifest = parseAgentManifest(JSON.stringify(data)).model;
    expect(selectedArguments(manifest, [], { model: "allowed" })).toEqual(["--model", "allowed"]);
    expect(() => selectedArguments(manifest, [], { model: "other" })).toThrow("invalid_request");
  });
  it.each([
    { flags: ["--model"], arguments: ["--other", "{value}"] },
    { flags: ["--model"], arguments: ["--model", "{prompt}"] },
    { flags: ["--model"], arguments: ["--model", "{value}", "--unsafe"] },
    { flags: ["--model"], arguments: ["--model", "{value}"], extra: true },
  ])("rejects unsafe selection templates %j", (model) => {
    expect(() =>
      parseAgentManifest(JSON.stringify({ ...fixture, launch: { ...fixture.launch, model } })),
    ).toThrow();
  });
  it("requires a fixed effort enum", () => {
    expect(() =>
      parseAgentManifest(
        JSON.stringify({
          ...fixture,
          launch: {
            ...fixture.launch,
            effort: { flags: ["--effort"], arguments: ["--effort", "{value}"] },
          },
        }),
      ),
    ).toThrow();
  });
});

describe("selector argument ownership", () => {
  const claude = bundledProviders.find((entry) => entry.id === "claude");
  const codex = bundledProviders.find((entry) => entry.id === "codex");
  if (!claude || !codex) throw new Error("missing bundled provider");
  it.each([
    "--append-system-prompt",
    "--system-prompt",
    "--append-system-prompt-file",
    "--system-prompt-file",
  ])("preserves literal values belonging to %s", (flag) => {
    for (const literal of ["--model=opus", "--effort=high", "--model", "--effort"]) {
      const defaults = parseAgentArguments("claude", [
        flag,
        literal,
        "--verbose",
        "--model",
        "old",
        "--effort=high",
      ]);
      expect(selectedArguments(claude.model, defaults, { model: "sonnet", effort: "low" })).toEqual(
        [flag, literal, "--verbose", "--model", "sonnet", "--effort", "low"],
      );
    }
  });
  it("preserves multiple prompt values without shifting ownership between selections", () => {
    const defaults = [
      "--append-system-prompt",
      "--effort=high",
      "--model=old",
      "--system-prompt",
      "--model=opus",
      "--effort",
      "high",
    ];
    expect(selectedArguments(claude.model, defaults, { model: "sonnet", effort: "low" })).toEqual([
      "--append-system-prompt",
      "--effort=high",
      "--system-prompt",
      "--model=opus",
      "--model",
      "sonnet",
      "--effort",
      "low",
    ]);
  });
  it("does not replace a value owned by an unselected selector or another config key", () => {
    expect(
      selectedArguments(claude.model, ["--model", "--effort=high"], { effort: "low" }),
    ).toEqual(["--model", "--effort=high", "--effort", "low"]);
    expect(
      selectedArguments(codex.model, ["--config", "--model=literal"], { model: "new" }),
    ).toEqual(["--config", "--model=literal", "--model", "new"]);
  });
  it("does not reparse suspicious values after removing their selector", () => {
    expect(
      selectedArguments(claude.model, ["--model", "--effort=high"], {
        model: "sonnet",
        effort: "low",
      }),
    ).toEqual(["--effort=high", "--model", "sonnet", "--effort", "low"]);
  });
  it("honors config manifest ownership, including single-value short options", () => {
    const manifest = parseAgentManifest(
      JSON.stringify({
        ...fixture,
        launch: {
          ...fixture.launch,
          valueFlags: ["--literal", "-p"],
          model: { flags: ["--model"], arguments: ["--model", "{value}"] },
        },
      }),
    ).model;
    const defaults = [
      "--literal",
      "--model=literal",
      "-p",
      "--model",
      "--literal=inline",
      "--model=old",
      "-pinline",
      "--model=older",
    ];
    expect(selectedArguments(manifest, defaults, { model: "new" })).toEqual([
      "--literal",
      "--model=literal",
      "-p",
      "--model",
      "--literal=inline",
      "-pinline",
      "--model",
      "new",
    ]);
  });
  it.each([
    null,
    "--literal",
    ["literal"],
    ["--literal", "--literal"],
    Array.from({ length: 65 }, (_, i) => `--flag${String(i)}`),
  ])("rejects invalid ownership metadata %j", (valueFlags) => {
    expect(() =>
      parseAgentManifest(JSON.stringify({ ...fixture, launch: { ...fixture.launch, valueFlags } })),
    ).toThrow();
  });
});
