// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DevelopmentBranch } from "../components/project/development-branch";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
let container: HTMLDivElement, root: Root;
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
async function render(props = {}) {
  await act(async () =>
    root.render(
      <DevelopmentBranch
        projectId="proj_test"
        branch={null}
        defaultBranch="main"
        canWrite={true}
        {...props}
      />,
    ),
  );
}
const input = () => container.querySelector("input") as HTMLInputElement;
const button = () => container.querySelector("button") as HTMLButtonElement;
async function change(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("shows fallback and sends only a scoped preference on save", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(Response.json({ settings: { developmentBranch: "develop" } }));
  vi.stubGlobal("fetch", fetch);
  await render();
  expect(container.textContent).toContain("GitHub default: main");
  expect(button().disabled).toBe(true);
  await change("develop");
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => button().click());
  expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({
    developmentBranch: "develop",
    idempotency_key: expect.stringMatching(/^ui-development-branch-/),
  });
  expect(fetch).toHaveBeenCalledWith(
    "/api/v1/projects/proj_test",
    expect.objectContaining({ method: "PATCH" }),
  );
  expect(container.querySelector("[role=status]")?.textContent).toContain("saved: develop");
  expect(refresh).toHaveBeenCalledOnce();
});
it("clears the override and requires server confirmation", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ settings: {} }))
    .mockResolvedValueOnce(Response.json({ settings: { developmentBranch: null } }));
  vi.stubGlobal("fetch", fetch);
  await render({ branch: "develop" });
  await change("");
  await act(async () => button().click());
  expect(container.querySelector("[role=alert]")?.textContent).toContain("did not confirm");
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => button().click());
  expect(JSON.parse(fetch.mock.calls[1]?.[1].body).developmentBranch).toBeNull();
  expect(container.querySelector("[role=status]")?.textContent).toContain("saved: main");
});
it("shows denied or unavailable updates without claiming success", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: { message: "Branch unavailable" } }, { status: 503 }),
      ),
  );
  await render();
  await change("missing");
  await act(async () => button().click());
  expect(container.querySelector("[role=alert]")?.textContent).toBe("Branch unavailable");
  expect(container.querySelector("[role=status]")).toBeNull();
  expect(refresh).not.toHaveBeenCalled();
});
it("disables editing without permission", async () => {
  await render({ canWrite: false, branch: "develop" });
  expect(input().disabled).toBe(true);
  expect(button()).toBeNull();
});
it("disables controls while branch validation is pending", async () => {
  let complete: (response: Response) => void = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
    ),
  );
  await render();
  await change("develop");
  await act(async () => button().click());
  expect(input().disabled).toBe(true);
  expect(button().textContent).toBe("saving…");
  await act(async () => complete(Response.json({ settings: { developmentBranch: "develop" } })));
  expect(input().disabled).toBe(false);
});
