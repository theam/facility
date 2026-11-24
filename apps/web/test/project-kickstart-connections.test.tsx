// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import KickstartPage from "../app/(app)/(org)/projects/new/page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
let container: HTMLDivElement;
let root: Root;
let fetch: ReturnType<typeof vi.fn>;
const installations = [
  {
    id: "a",
    installationId: 1,
    accountLogin: "alpha",
    connectionName: "Alpha",
    targetType: "Organization",
  },
  {
    id: "b",
    installationId: 2,
    accountLogin: "beta",
    connectionName: "Beta",
    targetType: "Organization",
  },
  {
    id: "c",
    installationId: 3,
    accountLogin: "alpha",
    connectionName: "Second Alpha",
    targetType: "Organization",
  },
];
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/v1/github/installations") return Response.json(installations);
    if (url.startsWith("/api/v1/github/installations/")) return Response.json({ items: [] });
    if (url === "/api/v1/projects") return Response.json({ id: "project", name: "Service" });
    if (url === "/api/v1/projects/project/repos")
      return Response.json(
        init?.method === "POST" ? { id: "repo", ...JSON.parse(String(init.body)) } : [],
      );
    if (url.includes("/kickstart/preview")) return Response.json({ files: [] });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  await act(async () => root.render(<KickstartPage />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing button ${label}`);
  await act(async () => button.click());
}
async function type(placeholder: string, value: string) {
  const input = container.querySelector(`input[placeholder="${placeholder}"]`);
  if (!input) throw new Error(`Missing input ${placeholder}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function connected() {
  const call = fetch.mock.calls.find(
    ([url, init]) => url === "/api/v1/projects/project/repos" && init?.method === "POST",
  );
  return call ? JSON.parse(String(call[1]?.body)) : undefined;
}
it.each([
  ["Beta · beta", "beta/service", 2],
  ["Second Alpha · alpha", "alpha/service", 3],
])("selects %s directly in manual mode", async (label, repo, installationId) => {
  await click("type owner/name");
  await click(String(label));
  await type("acme/payments-service", String(repo));
  await click("Preview kickstart");
  expect(connected()).toMatchObject({
    installationId,
    owner: String(repo).split("/")[0],
    name: "service",
  });
});
it("lets new repository setup select the destination connection", async () => {
  await click("new repository");
  await type("my-service", "service");
  await click("Beta · beta");
  await click("Preview kickstart");
  expect(connected()).toMatchObject({
    installationId: 2,
    owner: "beta",
    name: "service",
    create: true,
  });
});
it("rejects an owner mismatch before creating an orphaned draft", async () => {
  await click("type owner/name");
  await type("acme/payments-service", "beta/service");
  await click("Preview kickstart");
  expect(container.textContent).toContain("Select a GitHub connection for beta");
  expect(
    fetch.mock.calls.some(([url, init]) => url === "/api/v1/projects" && init?.method === "POST"),
  ).toBe(false);
});
