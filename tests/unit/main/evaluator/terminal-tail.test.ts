import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import {
  addTailSecrets,
  clearTailSecrets,
  prepareTail,
} from "../../../../src/main/evaluator/terminal-tail";

it("returns at most 40 physical lines and handles CRLF and embedded newlines", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${String(i)}`);
  expect(prepareTail(lines).split("\n")).toEqual(lines.slice(-40));
  expect(prepareTail([lines.join("\r\n")]).split("\n")).toEqual(lines.slice(-40));
  expect(prepareTail(["a\rb\u0000"])).toBe("a\nb");
  expect(() => prepareTail(["a".repeat(131073)])).toThrow("Tail too large");
});
it.each([
  'OPENAI_API_KEY="private-value"',
  "password: private-value",
  '"client_secret": "private-value"',
  "Authorization: Basic private-value",
  "Cookie: session=private-value",
  "Bearer private-value",
  "sk-private-value",
  "ghp_private_value",
  "github_pat_private_value",
  "xoxb-private-value",
  "AIzaabcdefghijklmnopqrstuvwxyz",
  "AKIA1234567890ABCDEF",
  "ASIA1234567890ABCDEF",
  "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoicHJpdmF0ZSJ9.signature",
  "https://user:private-value@example.com",
])("redacts likely credentials: %s", (secret) => {
  const output = prepareTail([secret]);
  expect(output).toContain("[REDACTED");
  expect(output).not.toContain("private-value");
  expect(output).not.toContain(secret);
});
it("redacts complete and truncated private keys before trimming lines", () => {
  for (const end of ["-----END RSA PRIVATE KEY-----", ""]) {
    expect(
      prepareTail([
        "-----BEGIN RSA PRIVATE KEY-----",
        ...Array<string>(50).fill("private material"),
        end,
      ]),
    ).not.toContain("private material");
  }
  expect(prepareTail(["Working...", "Continue?"])).toBe("Working...\nContinue?");
});
it("preserves original line boundaries when redacting multiline secrets", () => {
  const tail = [
    "old content outside the allowed tail",
    "-----BEGIN PRIVATE KEY-----",
    ...Array<string>(50).fill("private material"),
    "-----END PRIVATE KEY-----",
    "Current output",
  ];
  const result = prepareTail(tail);
  expect(result.split("\n")).toHaveLength(40);
  expect(result).not.toContain("old content");
  expect(result).not.toContain("private material");
  expect(result).toContain("Current output");
  expect(prepareTail(["Password: ", "Enter login password:"])).toBe(
    "Password: \nEnter login password:",
  );
  expect(prepareTail(["API_KEY=\u0000private-value"])).not.toContain("private-value");
});

it("redacts a generated private key after the host has already selected its last 40 lines", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 4096 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trimEnd().split("\n");
  expect(pem.length).toBeGreaterThan(40);
  const tail = [...pem, "Continue?"].slice(-40);
  expect(tail.join("\n")).not.toContain("BEGIN");
  const redacted = prepareTail(tail);
  expect(redacted.split("\n")).toHaveLength(40);
  expect(redacted).toContain("[REDACTED PRIVATE KEY]");
  expect(redacted.endsWith("Continue?")).toBe(true);
  for (const line of tail.slice(0, -2)) {
    expect(redacted).not.toContain(line);
  }
});

it.each([
  "PRIVATE KEY",
  "RSA PRIVATE KEY",
  "EC PRIVATE KEY",
  "OPENSSH PRIVATE KEY",
  "ENCRYPTED PRIVATE KEY",
])("redacts headerless %s fragments through END while retaining later output", (label) => {
  const tail = ["partial body", "nonstandard body", `-----END ${label}-----`, "Working..."];
  expect(prepareTail(tail).split("\n")).toEqual([
    "[REDACTED PRIVATE KEY]",
    "[REDACTED PRIVATE KEY]",
    "[REDACTED PRIVATE KEY]",
    "Working...",
  ]);
});

it("redacts markerless leading PEM body lines and a short padded final line", () => {
  const body = "Ab9+/Z".repeat(10) + "abcd";
  for (const ending of [[], ["YWJjZA=="], ["YWJjZA==", "Continue?"]]) {
    const tail = [...Array<string>(40).fill(body), ...ending].slice(-40);
    const result = prepareTail(tail);
    expect(result.split("\n")).toHaveLength(40);
    expect(result).not.toContain(body);
    expect(result).not.toContain("YWJjZA==");
  }
  expect(prepareTail([body, "", "Continue?"])).toBe("[REDACTED PRIVATE KEY]\n\nContinue?");
});

it("handles multiple complete and headerless blocks without leaking earlier material", () => {
  expect(
    prepareTail([
      "orphan body",
      "-----END PRIVATE KEY-----",
      "between blocks",
      "-----BEGIN RSA PRIVATE KEY-----",
      "body",
      "-----END RSA PRIVATE KEY-----",
      "another orphan",
      "-----END EC PRIVATE KEY-----",
      "Continue?",
    ]).split("\n"),
  ).toEqual([...Array<string>(8).fill("[REDACTED PRIVATE KEY]"), "Continue?"]);
});

it("redacts every Environment secret literally, longest first, for the life of the app", () => {
  addTailSecrets(["hunter2-long", "hunter2", "", "proxy-user:hunter2"]);
  addTailSecrets(["ab"]);
  try {
    expect(prepareTail(["echo hunter2 and hunter2-long", "via proxy-user:hunter2 ab"])).toBe(
      "echo [REDACTED SECRET] and [REDACTED SECRET]\nvia [REDACTED SECRET] [REDACTED SECRET]",
    );
    // A later settings change adds values; replaced secrets stay redacted.
    addTailSecrets(["other"]);
    expect(prepareTail(["hunter2 other"])).toBe("[REDACTED SECRET] [REDACTED SECRET]");
  } finally {
    clearTailSecrets();
  }
  expect(prepareTail(["hunter2"])).toBe("hunter2");
});
