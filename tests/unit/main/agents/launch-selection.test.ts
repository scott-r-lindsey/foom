import { describe, expect, it } from "vitest";
import {
  selectedArguments,
  selectionInput,
  validateSelection,
} from "../../../../src/node-common/launch-selection";
import { bundledProviders } from "../../../../src/main/agents/providers/bundled";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import fixture from "../../../fixtures/agent-plugin.json";

describe("bounded per-child launch selections", () => {
  it.each(bundledProviders)("expands the $id model using only its declared argv", (provider) => {
    expect(
      selectedArguments(provider.model, ["--other", "keep"], { model: "provider/model:v1" }),
    ).toEqual(["--other", "keep", "--model", "provider/model:v1"]);
  });
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
