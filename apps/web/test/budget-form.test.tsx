// @vitest-environment jsdom
import type { ProjectBudget } from "@facility/sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BudgetForm } from "../components/insights/budget-form";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

let container: HTMLDivElement;
let root: Root;
const budget: ProjectBudget = {
  id: "bud_test",
  enabled: true,
  monthly_limit_cents: 25_000,
  turn_limit_cents: 500,
  warning_percent: 80,
  window_start: "2026-11-01T00:00:00.000Z",
  window_end: "2026-12-01T00:00:00.000Z",
  spent_cents: 0,
  remaining_cents: 25_000,
  percent_used: 0,
  state: "ok",
  enforcement: "block_new_turns",
};

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

async function render(value: ProjectBudget = budget) {
  await act(async () => root.render(<BudgetForm projectId="proj_test" budget={value} />));
}
function field(label: string) {
  const match = [...container.querySelectorAll("label")].find((element) =>
    element.textContent?.startsWith(label),
  );
  const input = match?.querySelector("input");
  if (!input) throw Error(`Missing ${label}`);
  return input;
}
async function type(label: string, value: string) {
  await act(async () => {
    const input = field(label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
function sentBody(fetch: ReturnType<typeof vi.fn>) {
  const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body));
}

it("shows the current per-turn limit next to the monthly limit and saves it in cents", async () => {
  const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  await render();
  expect(field("Per-turn limit (USD)").value).toBe("5");
  expect(field("Monthly limit (USD)").value).toBe("250");
  expect(container.textContent).toContain("Enforce both limits for new turns");

  await type("Per-turn limit (USD)", "7.25");
  await submit();

  expect(fetch).toHaveBeenCalledWith(
    "/api/v1/projects/proj_test/budget",
    expect.objectContaining({ method: "PATCH" }),
  );
  expect(sentBody(fetch)).toEqual({
    monthly_limit_cents: 25_000,
    turn_limit_cents: 725,
    warning_percent: 80,
    enabled: true,
  });
  expect(refresh).toHaveBeenCalled();
});

it("removes the per-turn limit when the field is left empty", async () => {
  const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  await render();
  await type("Per-turn limit (USD)", "  ");
  await submit();
  expect(sentBody(fetch)).toMatchObject({ turn_limit_cents: null });
});

it("starts empty without a configured per-turn limit", async () => {
  vi.stubGlobal("fetch", vi.fn());
  await render({ ...budget, turn_limit_cents: null });
  expect(field("Per-turn limit (USD)").value).toBe("");
});

it.each([
  "0",
  "0.001",
  "-2",
  "five",
])("rejects a per-turn limit of %s without a request", async (value) => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await render();
  await type("Per-turn limit (USD)", value);
  await submit();
  expect(fetch).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("per-turn limit");
});

it("shows the server's refusal, such as a missing permission", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "missing permission budgets:write" } }), {
          status: 403,
        }),
    ),
  );
  await render();
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "missing permission budgets:write",
  );
  expect(refresh).not.toHaveBeenCalled();
});
