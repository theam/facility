// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GithubConnections } from "../components/settings/github-connections";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function button(label: string) {
  const element = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!element) throw new Error(`Missing ${label}`);
  return element;
}
it("keeps administration unavailable to a reader", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json([])),
  );
  await act(async () => root.render(<GithubConnections canManage={false} />));
  expect(container.textContent).toContain("instance default");
  expect(container.querySelector("form")).toBeNull();
  expect(container.querySelector("button")).toBeNull();
});
it("submits credentials once, clears the form after rejection, and does not claim success", async () => {
  const fetch = vi.fn(async (_url, init) =>
    init?.method === "POST"
      ? Response.json({ error: { message: "GitHub rejected the installation" } }, { status: 400 })
      : Response.json([]),
  );
  vi.stubGlobal("fetch", fetch);
  await act(async () => root.render(<GithubConnections canManage />));
  await act(async () => button("Add GitHub connection").click());
  const form = container.querySelector("form");
  if (!form) throw new Error("Missing form");
  for (const [name, value] of Object.entries({
    name: "NAU",
    appId: "23",
    installationId: "24",
    privateKey: "sensitive-pem",
    webhookSecret: "x".repeat(32),
  })) {
    const field = form.elements.namedItem(name) as HTMLInputElement;
    field.value = value;
  }
  expect(button("Verify and save").type).toBe("submit");
  await act(async () =>
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  const call = fetch.mock.calls.find(([, init]) => init?.method === "POST");
  expect(JSON.parse(call?.[1]?.body)).toMatchObject({ appId: 23, installationId: 24 });
  expect((form.elements.namedItem("privateKey") as HTMLTextAreaElement).value).toBe("");
  expect((form.elements.namedItem("webhookSecret") as HTMLInputElement).value).toBe("");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("GitHub rejected");
  expect(container.textContent).not.toContain("Connection verified");
});
it("shows verified connection metadata and the exact webhook URL", async () => {
  const connection = {
    id: "ghc_1",
    name: "NAU",
    slug: "nau-agent",
    appId: 23,
    disabledAt: null,
    webhookUrl: "https://facility.example/webhooks/github/ghc_1",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json([connection])),
  );
  await act(async () => root.render(<GithubConnections canManage />));
  expect(container.textContent).toContain(connection.webhookUrl);
  expect(button("Disable connection")).toBeTruthy();
  await act(async () => button("Rotate credentials").click());
  expect(container.querySelector('input[name="appId"]')).toBeNull();
  expect(
    (container.querySelector('textarea[name="privateKey"]') as HTMLTextAreaElement).value,
  ).toBe("");
});

it("requires confirmation before disabling a connection shared by projects", async () => {
  const connection = {
    id: "ghc_1",
    name: "NAU",
    slug: "nau-agent",
    appId: 23,
    disabledAt: null,
    webhookUrl: "https://facility.example/webhooks/github/ghc_1",
  };
  const fetch = vi.fn(async () => Response.json([connection]));
  vi.stubGlobal("fetch", fetch);
  await act(async () => root.render(<GithubConnections canManage />));
  await act(async () => button("Disable connection").click());
  expect(container.textContent).toContain("Every project using it");
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => button("Keep enabled").click());
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => button("Disable connection").click());
  await act(async () => button("Confirm disable").click());
  expect(fetch).toHaveBeenCalledWith(
    "/api/v1/github/connections/ghc_1",
    expect.objectContaining({ method: "PATCH", body: JSON.stringify({ disabled: true }) }),
  );
});
