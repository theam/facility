// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativePreviews } from "../components/project/native-previews";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
let container: HTMLDivElement;
let root: Root;
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
      <NativePreviews
        projectId="proj_pilot"
        enabled={false}
        available={true}
        canWrite={true}
        {...props}
      />,
    ),
  );
}
function input() {
  const value = container.querySelector("input");
  if (!value) throw Error("Missing switch");
  return value;
}
function button() {
  const value = container.querySelector("button");
  if (!value) throw Error("Missing save");
  return value;
}
it("starts off, requires save and sends only the scoped preference", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ nativePreviews: { enabled: true } }));
  vi.stubGlobal("fetch", fetch);
  await render();
  expect(input().checked).toBe(false);
  expect(button().disabled).toBe(true);
  await act(async () => input().click());
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => button().click());
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "/api/v1/projects/proj_pilot",
    expect.objectContaining({
      method: "PATCH",
      headers: expect.objectContaining({
        "idempotency-key": expect.stringMatching(/^ui-native-previews-/),
      }),
    }),
  );
  expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({
    nativePreviewsEnabled: true,
    idempotency_key: expect.any(String),
  });
  expect(container.querySelector("[role=status]")?.textContent).toBe("Project opt-in saved.");
  expect(refresh).toHaveBeenCalledOnce();
});
it("explains unavailable installation support without claiming activation", async () => {
  await render({ available: false, enabled: true });
  expect(input().checked).toBe(true);
  expect(container.querySelector("[role=note]")?.textContent).toContain(
    "Not available on this installation yet",
  );
  expect(container.textContent).toContain("not anonymous public previews");
});
it("readers can inspect the setting but cannot change it", async () => {
  await render({ canWrite: false });
  expect(input().disabled).toBe(true);
  expect(container.querySelector("button")).toBeNull();
});
it("shows failures without claiming success and allows retry", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(Response.json({ error: { message: "Not allowed" } }, { status: 403 })),
  );
  await render();
  await act(async () => input().click());
  await act(async () => button().click());
  expect(container.querySelector("[role=alert]")?.textContent).toBe("Not allowed");
  expect(container.querySelector("[role=status]")).toBeNull();
  expect(button().disabled).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
});
it("can disable an opted-in project", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ nativePreviews: { enabled: false } }));
  vi.stubGlobal("fetch", fetch);
  await render({ enabled: true });
  await act(async () => input().click());
  await act(async () => button().click());
  expect(JSON.parse(fetch.mock.calls[0]?.[1].body).nativePreviewsEnabled).toBe(false);
  expect(container.querySelector("[role=status]")?.textContent).toContain(
    "disabled for this project",
  );
});
it("does not claim a save against an older API that ignores the new field", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ settings: {} })));
  await render();
  await act(async () => input().click());
  await act(async () => button().click());
  expect(container.querySelector("[role=alert]")?.textContent).toContain("server did not confirm");
  expect(container.querySelector("[role=status]")).toBeNull();
  expect(refresh).not.toHaveBeenCalled();
});
