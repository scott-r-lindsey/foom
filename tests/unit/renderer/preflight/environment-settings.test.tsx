// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { EnvironmentApi, EnvironmentState } from "../../../../src/shared/environment";
import { EnvironmentSettings } from "../../../../src/renderer/preflight/environment-settings";

afterEach(cleanup);

function state(lists: Partial<EnvironmentState["lists"]> = {}, extra = {}): EnvironmentState {
  return {
    lists: { all: [], claude: [], codex: [], agy: [], ...lists },
    windows: false,
    secrets: true,
    ...extra,
  };
}
const corp = state({
  all: [
    { name: "HTTPS_PROXY", value: "http://proxy:8080", secret: false },
    { name: "PATH", value: "/opt/bin", secret: false },
  ],
  claude: [{ name: "HTTPS_PROXY", value: null, secret: true }],
});

function source(initial = corp) {
  const api = {
    environmentState: vi.fn<EnvironmentApi["environmentState"]>().mockResolvedValue(initial),
    saveEnvironment: vi.fn<EnvironmentApi["saveEnvironment"]>().mockResolvedValue(initial),
    removeEnvironment: vi.fn<EnvironmentApi["removeEnvironment"]>().mockResolvedValue(initial),
    readShellEnvironment: vi.fn<EnvironmentApi["readShellEnvironment"]>().mockResolvedValue([]),
    importEnvironment: vi.fn<EnvironmentApi["importEnvironment"]>().mockResolvedValue(initial),
  };
  render(<EnvironmentSettings source={api} headingRef={null} />);
  return api;
}
const row = (scope: string, name: string) =>
  within(screen.getByRole("region", { name: scope })).getByRole("group", { name });

test("shows lists with masked secrets, overrides, PATH prepending and the loopback entries", async () => {
  source();
  const claude = await screen.findByRole("region", { name: "Claude Code" });
  expect(within(claude).getByLabelText("Saved secret").textContent).toBe("••••••••");
  expect(within(claude).getByText("overrides all")).toBeTruthy();
  expect(within(claude).getByRole("button", { name: "Secret" })).toHaveProperty("disabled", true);
  expect(within(row("All sessions", "PATH")).getByText(":$PATH")).toBeTruthy();
  const added = within(screen.getByRole("region", { name: "All sessions" })).getByLabelText(
    "Added by Foom",
  );
  expect(added.textContent).toBe("NO_PROXYlocalhost,127.0.0.1,::1");
  expect(screen.queryByText(/hunter/)).toBeNull();
});

test("a new valid row saves when focus leaves it; invalid rows show reasons and stay local", async () => {
  const api = source(state());
  const blank = await screen.findByLabelText("New Codex variable name");
  fireEvent.change(blank, { target: { value: "CODEX HOME" } });
  const group = row("Codex", "CODEXHOME");
  fireEvent.change(within(group).getByLabelText("CODEXHOME value"), {
    target: { value: "/home/me/.codex" },
  });
  fireEvent.focusOut(within(group).getByLabelText("CODEXHOME value"));
  await waitFor(() => {
    expect(api.saveEnvironment).toHaveBeenCalledExactlyOnceWith({
      scope: "codex",
      previous: null,
      name: "CODEXHOME",
      value: "/home/me/.codex",
      secret: false,
    });
  });
  expect(screen.getByRole("status").textContent).toBe("Saved for new sessions");
  fireEvent.change(screen.getByLabelText("New All sessions variable name"), {
    target: { value: "LD_PRELOAD" },
  });
  const refused = row("All sessions", "LD_PRELOAD");
  expect(within(refused).getByRole("alert").textContent).toBe(
    "LD_PRELOAD can't be set: it loads code into every process",
  );
  fireEvent.focusOut(within(refused).getByLabelText("Variable name"));
  expect(api.saveEnvironment).toHaveBeenCalledOnce();
  fireEvent.click(within(refused).getByRole("button", { name: "Remove LD_PRELOAD" }));
  expect(screen.queryByRole("group", { name: "LD_PRELOAD" })).toBeNull();
});

test("credentials in a URL force Secret; main's refusal is shown on the row", async () => {
  const api = source();
  api.saveEnvironment.mockRejectedValueOnce(
    new Error("Error invoking remote method 'environment:save': Error: Refused by main"),
  );
  await screen.findByRole("region", { name: "Codex" });
  fireEvent.change(screen.getByLabelText("New Codex variable name"), {
    target: { value: "HTTPS_PROXY" },
  });
  const group = row("Codex", "HTTPS_PROXY");
  const value = within(group).getByLabelText("HTTPS_PROXY value");
  fireEvent.change(value, { target: { value: "http://sam:hunter2@proxy:3128" } });
  expect(value).toHaveProperty("type", "password");
  const secret = within(group).getByRole("button", { name: "Secret" });
  expect(secret.getAttribute("aria-pressed")).toBe("true");
  expect(secret).toHaveProperty("disabled", true);
  fireEvent.focusOut(value);
  await waitFor(() => {
    expect(within(group).getByRole("alert").textContent).toBe("Refused by main");
  });
  expect(api.saveEnvironment).toHaveBeenCalledWith(
    expect.objectContaining({ name: "HTTPS_PROXY", secret: true }),
  );
});

test("secret toggles save at once; Replace and remove use main without reading values", async () => {
  const api = source();
  const path = await waitFor(() => row("All sessions", "PATH"));
  fireEvent.click(within(path).getByRole("button", { name: "Secret" }));
  await waitFor(() => {
    expect(api.saveEnvironment).toHaveBeenCalledWith({
      scope: "all",
      previous: "PATH",
      name: "PATH",
      value: "/opt/bin",
      secret: true,
    });
  });
  const claude = row("Claude Code", "HTTPS_PROXY");
  fireEvent.click(within(claude).getByRole("button", { name: "Replace" }));
  expect(within(claude).getByLabelText("HTTPS_PROXY value")).toHaveProperty("value", "");
  fireEvent.click(within(claude).getByRole("button", { name: "Remove HTTPS_PROXY" }));
  await waitFor(() => {
    expect(api.removeEnvironment).toHaveBeenCalledWith("claude", "HTTPS_PROXY");
  });
});

test("import offers main's candidates and adds only the picked ones", async () => {
  const api = source(state({ all: [{ name: "NO_PROXY", value: ".corp", secret: false }] }));
  api.readShellEnvironment.mockResolvedValue([
    { name: "HTTPS_PROXY", display: "http://me:••••@proxy", status: "new" },
    { name: "NO_PROXY", display: ".corp", status: "same" },
    { name: "SSL_CERT_FILE", display: "/certs/a.pem", status: "new" },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "Import from login shell" }));
  const picker = await screen.findByRole("group", { name: "Import from login shell" });
  expect(within(picker).getByText("already set")).toBeTruthy();
  const boxes = within(picker).getAllByRole("checkbox");
  expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([true, false, true]);
  fireEvent.click(boxes[2] as HTMLElement);
  await act(async () => {
    fireEvent.click(within(picker).getByRole("button", { name: "Add selected" }));
    await Promise.resolve();
  });
  expect(api.importEnvironment).toHaveBeenCalledExactlyOnceWith(["HTTPS_PROXY"]);
  await waitFor(() => {
    expect(screen.queryByRole("group", { name: "Import from login shell" })).toBeNull();
  });
  api.readShellEnvironment.mockRejectedValueOnce(new Error("Unable to read the login shell"));
  fireEvent.click(screen.getByRole("button", { name: "Import from login shell" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Unable to read the login shell");
});

test("reports a failed load and refuses secrets without a keychain", async () => {
  const api = {
    environmentState: vi.fn().mockRejectedValue(new Error("Unavailable")),
  } as unknown as EnvironmentApi;
  render(<EnvironmentSettings source={api} headingRef={null} />);
  expect((await screen.findByRole("alert")).textContent).toBe("Unavailable");
  cleanup();
  source(state({}, { secrets: false, windows: true }));
  fireEvent.change(await screen.findByLabelText("New All sessions variable name"), {
    target: { value: "Path" },
  });
  const group = row("All sessions", "Path");
  expect(within(group).getByText(";%PATH%")).toBeTruthy();
  expect(within(group).getByRole("button", { name: "Secret" })).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("New Codex variable name"), {
    target: { value: "TOKEN_URL" },
  });
  const token = row("Codex", "TOKEN_URL");
  fireEvent.change(within(token).getByLabelText("TOKEN_URL value"), {
    target: { value: "http://u:p@h" },
  });
  expect(within(token).getByRole("alert").textContent).toContain("keychain");
});
