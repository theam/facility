// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DisconnectRepository } from "../components/project/disconnect-repository";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
let container: HTMLDivElement;
let root: Root;
const repository = { id: "repo_test", owner: "example", name: "app", role: "primary" as const };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  refresh.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(canWrite = true) {
  await act(async () =>
    root.render(
      <DisconnectRepository projectId="proj_test" repository={repository} canWrite={canWrite} />,
    ),
  );
}
function button(text: string) {
  const result = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!result) throw Error(`Missing ${text}`);
  return result;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function confirm() {
  await click("disconnect");
  const input = container.querySelector("input");
  if (!input) throw Error("Missing confirmation");
  await act(async () => input.click());
}

it("requires an explicit confirmation and permits cancelling without a request", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await render();
  await click("disconnect");
  expect(container.textContent).toContain("example/app");
  expect(container.textContent).toContain("oldest remaining repository becomes primary");
  expect(container.textContent).toContain("GitHub repository is not deleted");
  expect(button("confirm disconnect").disabled).toBe(true);
  await click("confirm disconnect");
  await click("cancel");
  expect(fetch).not.toHaveBeenCalled();
  expect(button("disconnect")).toBeTruthy();
});
it("shows progress, sends the exact scoped DELETE, and refreshes after success", async () => {
  let complete: (response: Response) => void = () => {
    throw Error("Request not started");
  };
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  await render();
  await confirm();
  await click("confirm disconnect");
  expect(button("disconnecting…").disabled).toBe(true);
  expect(button("cancel").disabled).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    "/api/v1/projects/proj_test/repos/repo_test",
    expect.objectContaining({
      method: "DELETE",
      headers: expect.objectContaining({
        "idempotency-key": expect.stringMatching(/^ui-disconnect-/),
      }),
    }),
  );
  await act(async () => complete(Response.json({ ok: true })));
  expect(container.querySelector("[role='status']")?.textContent).toBe("Repository disconnected.");
  expect(refresh).toHaveBeenCalledTimes(1);
});
it.each([
  403, 409, 500,
])("shows a %s failure without claiming removal or refreshing", async (status) => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: { message: "Repository is still in use" } }, { status }),
      ),
  );
  await render();
  await confirm();
  await click("confirm disconnect");
  expect(container.querySelector("[role='alert']")?.textContent).toBe("Repository is still in use");
  expect(container.querySelector("[role='status']")).toBeNull();
  expect(button("confirm disconnect").disabled).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
});
it("does not expose the action to readers", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await render(false);
  expect(container.querySelector("button")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
