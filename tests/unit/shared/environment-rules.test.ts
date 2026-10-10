import { expect, test } from "vitest";
import {
  environmentProblem,
  foldName,
  hasUrlCredentials,
  maskCredentials,
  nameProblem,
  urlCredentials,
} from "../../../src/shared/environment-rules";

test.each([
  ["FOOM_CONTROL_URL", "FOOM_CONTROL_URL is reserved by Foom"],
  ["foom_session", "foom_session is reserved by Foom"],
  ["CLAUDECODE", "CLAUDECODE is reserved by Foom"],
  ["TERM", "TERM is reserved by Foom"],
  ["LD_PRELOAD", "LD_PRELOAD can't be set: it loads code into every process"],
  ["LD_LIBRARY_PATH", "LD_LIBRARY_PATH can't be set: it loads code into every process"],
  ["DYLD_INSERT_LIBRARIES", "DYLD_INSERT_LIBRARIES can't be set: it loads code into every process"],
  ["node_options", "node_options can't be set: it loads code into every process"],
  ["ELECTRON_RUN_AS_NODE", "ELECTRON_RUN_AS_NODE can't be set: it loads code into every process"],
  ["BASH_ENV", "BASH_ENV can't be set: it loads code into every process"],
  ["ENV", "ENV can't be set: it loads code into every process"],
  ["PROMPT_COMMAND", "PROMPT_COMMAND can't be set: it loads code into every process"],
  ["", "Names use letters, digits and _, and can't start with a digit"],
  ["9LIVES", "Names use letters, digits and _, and can't start with a digit"],
  ["A-B", "Names use letters, digits and _, and can't start with a digit"],
  ["A".repeat(257), "Names are at most 256 characters"],
])("refuses the name %s", (name, reason) => {
  expect(nameProblem(name)).toBe(reason);
});

test("values are literal, bounded, and checked for PATH and proxies", () => {
  expect(environmentProblem("A", "$HOME and `x`", false)).toBeNull();
  expect(environmentProblem("A", "a\0b", false)).toBe("Values can't contain NUL");
  expect(environmentProblem("A", "x".repeat(4097), false)).toBe(
    "Values are at most 4096 characters",
  );
  expect(environmentProblem("PATH", "/opt/bin:/usr/local/x", false)).toBeNull();
  for (const value of ["", "bin", "/a::/b", "C:\\Tools"])
    expect(environmentProblem("Path", value, false)).toBe(
      "PATH entries must be absolute directories",
    );
  expect(environmentProblem("PATH", "C:\\Tools;\\\\server\\share\\bin;D:/x", true)).toBeNull();
  expect(environmentProblem("PATH", "/usr/bin", true)).not.toBeNull();
  for (const value of ["http://p:8080", "HTTPS://u:p@p", "socks5://s:1080", ""])
    expect(environmentProblem("https_proxy", value, false)).toBeNull();
  for (const value of ["proxy:8080", "ftp://p", "http://", "http:// p", "http://[bad"])
    expect(environmentProblem("ALL_PROXY", value, false)).toBe(
      "Must be an http://, https:// or socks5:// URL",
    );
  expect(environmentProblem("NO_PROXY", "anything,goes", false)).toBeNull();
});

test("URL credentials are detected, extracted and masked", () => {
  expect(hasUrlCredentials("http://sam:hunter2@proxy:3128")).toBe(true);
  expect(hasUrlCredentials(" https://token@proxy")).toBe(true);
  expect(hasUrlCredentials("http://proxy:3128/a@b")).toBe(false);
  expect(hasUrlCredentials("user:pass@host")).toBe(false);
  expect(urlCredentials("http://sam:hunter2@proxy")).toBe("sam:hunter2");
  expect(urlCredentials("http://proxy")).toBeNull();
  expect(maskCredentials("http://sam:hunter2@proxy:3128")).toBe("http://sam:••••@proxy:3128");
  expect(maskCredentials("http://token@proxy")).toBe("http://••••@proxy");
  expect(maskCredentials("http://:pw@proxy")).toBe("http://••••@proxy");
  expect(maskCredentials("/certs/a.pem")).toBe("/certs/a.pem");
  expect(foldName("Path", true)).toBe("PATH");
  expect(foldName("Path", false)).toBe("Path");
});
