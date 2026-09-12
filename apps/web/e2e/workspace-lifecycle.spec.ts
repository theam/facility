import { expect, type Page, test } from "@playwright/test";

const api = "http://127.0.0.1:4491";
const list = "/projects/proj_ui/stories";
const story = `${list}/story_ui`;
const endpoint = "/v1/projects/proj_ui/workspace-stories/story_ui";

test.beforeEach(async ({ request, context }) => {
  await request.post(`${api}/__reset`);
  await context.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === "127.0.0.1" ? route.continue() : route.abort();
  });
});

test("a workspace executor can create, suspend, continue, archive and restore through the UI", async ({
  page,
  request,
}) => {
  await page.goto(list);
  await expect(page.getByRole("link", { name: "Persistent UI story", exact: true })).toBeVisible();
  await page.getByLabel("What do you need?").fill("Keep the shared conversation");
  await page.getByRole("button", { name: "Start story", exact: true }).click();
  await expect(page).toHaveURL(story);
  await expect(page.getByRole("heading", { name: "Keep the shared conversation" })).toBeVisible();
  await openMaintenance(page);
  await page.getByRole("button", { name: "suspend compute" }).click();
  await expect(page.locator("dd").filter({ hasText: /^Suspended$/ })).toBeVisible();
  await page.getByRole("button", { name: "send a task", exact: true }).click();
  await page.getByLabel("Message", { exact: true }).fill("Continue in the same workspace");
  await page.getByRole("button", { name: "send to agent" }).click();
  await expect(page.locator("dd").filter({ hasText: /^Machine on$/ })).toBeVisible();
  await expect(page.getByText("Continue in the same workspace", { exact: true })).toBeVisible();
  await openMaintenance(page);
  await page.getByRole("button", { name: "archive", exact: true }).click();
  await expect(page.getByRole("button", { name: "restore", exact: true })).toBeVisible();
  await page.reload();
  await openMaintenance(page);
  await page.getByRole("button", { name: "restore", exact: true }).click();
  await expect(page.getByRole("button", { name: "archive", exact: true })).toBeVisible();
  await expect(
    page.locator("#conversation").getByText("Keep the shared conversation", { exact: true }),
  ).toBeVisible();
  await page.getByText("Environment details", { exact: true }).click();
  await expect(page.getByText("fixture-volume", { exact: true }).first()).toBeVisible();
  const state = await (await request.get(`${api}/__state`)).json();
  expect(state.requests.map((r: { path: string }) => r.path)).toEqual([
    endpoint.replace("/story_ui", ""),
    `${endpoint}/suspend`,
    `${endpoint}/messages`,
    `${endpoint}/archive`,
    `${endpoint}/restore`,
  ]);
  expect(state.requests.every((r: { surface: string }) => r.surface === "ui")).toBe(true);
});

test("deletion requires confirmation, permits retry, and leaves only history", async ({
  page,
  request,
}) => {
  await page.goto(story);
  await page.getByRole("button", { name: "send a task", exact: true }).click();
  await page.getByLabel("Message", { exact: true }).fill("History survives deletion");
  await page.getByRole("button", { name: "send to agent" }).click();
  await expect(page.getByText("History survives deletion", { exact: true })).toBeVisible();
  await openMaintenance(page);
  await page.getByText("Permanently delete workspace", { exact: true }).click();
  const confirm = page.getByRole("checkbox");
  const remove = page.getByRole("button", { name: "delete workspace", exact: true });
  await expect(remove).toBeDisabled();
  await confirm.check();
  await confirm.uncheck();
  await expect(remove).toBeDisabled();
  expect(
    (await (await request.get(`${api}/__state`)).json()).requests.filter(
      (r: { method: string }) => r.method === "DELETE",
    ),
  ).toHaveLength(0);
  await request.post(`${api}/__fail`, { data: { path: `${endpoint}/workspace`, status: 500 } });
  await confirm.check();
  await remove.click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Fixture operation failed");
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect(
    page.getByText("This workspace was permanently deleted.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /^(restore|archive|suspend compute|send to agent|send a task|delete workspace|run browser test)$/,
    }),
  ).toHaveCount(0);
  await expect(page.getByText("History survives deletion", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "restore", exact: true })).toHaveCount(0);
  const deletes = (await (await request.get(`${api}/__state`)).json()).requests.filter(
    (r: { method: string }) => r.method === "DELETE",
  );
  expect(deletes).toHaveLength(2);
  for (const deletion of deletes) {
    expect(deletion.body.confirm).toBe(true);
    expect(deletion.key).toBe(deletion.body.idempotency_key);
  }
});

test("failed lifecycle actions show an error and can be retried", async ({ page, request }) => {
  await page.goto(story);
  await request.post(`${api}/__fail`, { data: { path: `${endpoint}/archive`, status: 403 } });
  await openMaintenance(page);
  await page.getByRole("button", { name: "archive", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Fixture operation failed");
  await expect(page.getByRole("button", { name: "restore", exact: true })).toHaveCount(0);
  await openMaintenance(page);
  await page.getByRole("button", { name: "archive", exact: true }).click();
  await expect(page.getByRole("button", { name: "restore", exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});

test("read-only users have no execution or destructive controls", async ({ page, request }) => {
  await request.post(`${api}/__reset`, {
    data: { permissions: ["projects:read", "workspaces:read"] },
  });
  await page.goto(list);
  await expect(page.getByRole("button", { name: "Start story", exact: true })).toHaveCount(0);
  await page.goto(story);
  await expect(page.getByRole("heading", { name: "Persistent UI story" })).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /^(restore|archive|suspend compute|send to agent|send a task|delete workspace|run browser test)$/,
    }),
  ).toHaveCount(0);
  expect((await (await request.get(`${api}/__state`)).json()).requests).toHaveLength(0);
});

async function openMaintenance(page: Page) {
  const summary = page.locator("summary").filter({ hasText: /^maintenance/ });
  if (!(await summary.evaluate((element) => element.parentElement?.hasAttribute("open")))) {
    await summary.click();
  }
}
