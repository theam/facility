import { expect, type Page, test } from "@playwright/test";

test("real API retains workspace files and sessions through UI lifecycle and deletes only on confirmation", async ({
  page,
  context,
  request,
}) => {
  const setup = await request.post("http://127.0.0.1:4492/__fixture/setup");
  expect(setup.ok()).toBe(true);
  const fixture = await setup.json();
  await context.addCookies([
    { ...fixture.cookie, url: "http://127.0.0.1:3492", httpOnly: true, sameSite: "Lax" },
  ]);
  await context.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );
  const files = async () =>
    (await request.get(`http://127.0.0.1:4492/__fixture/${fixture.fixtureId}/files`)).json();
  await page.goto(`/projects/${fixture.projectId}/stories`);
  await page.getByLabel("What do you need?").fill("Create durable state");
  await page.getByRole("button", { name: "Start story", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create durable state" })).toBeVisible();
  const before = await files();
  expect(before.files).toEqual([
    "retained:untracked.txt",
    "retained:.facility/claude/session",
    "retained:.facility/codex/session",
  ]);
  await openMaintenance(page);
  await page.getByRole("button", { name: "suspend compute" }).click();
  await expect(page.locator("dd").filter({ hasText: /^Suspended$/ })).toBeVisible();
  expect((await files()).files).toEqual(before.files);
  await page.getByRole("button", { name: "send a task", exact: true }).click();
  await page.getByLabel("Message", { exact: true }).fill("Resume with the same files");
  await page.getByRole("button", { name: "send to agent" }).click();
  await expect(page.locator("dd").filter({ hasText: /^Machine on$/ })).toBeVisible();
  await openMaintenance(page);
  await page.getByRole("button", { name: "archive", exact: true }).click();
  await expect(page.getByRole("button", { name: "restore", exact: true })).toBeVisible();
  expect((await files()).files).toEqual(before.files);
  await page.reload();
  await openMaintenance(page);
  await page.getByRole("button", { name: "restore", exact: true }).click();
  await expect(page.getByRole("button", { name: "archive", exact: true })).toBeVisible();
  expect(await files()).toMatchObject({
    workspaceId: before.workspaceId,
    volumeRef: before.volumeRef,
    files: before.files,
  });
  await openMaintenance(page);
  await page.getByText("Permanently delete workspace", { exact: true }).click();
  const remove = page.getByRole("button", { name: "delete workspace", exact: true });
  await expect(remove).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page.getByRole("checkbox").uncheck();
  await expect(remove).toBeDisabled();
  expect((await files()).files).toEqual(before.files);
  await page.getByRole("checkbox").check();
  await remove.click();
  await expect(
    page.getByText("This workspace was permanently deleted.", { exact: false }),
  ).toBeVisible();
  expect(await files()).toMatchObject({ state: "destroyed", files: [null, null, null] });
  await expect(
    page.locator("#conversation").getByText("Create durable state", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: /^(restore|suspend compute|archive|send to agent|send a task)$/,
    }),
  ).toHaveCount(0);
});

async function openMaintenance(page: Page) {
  const summary = page.locator("summary").filter({ hasText: /^maintenance/ });
  if (!(await summary.evaluate((element) => element.parentElement?.hasAttribute("open")))) {
    await summary.click();
  }
}
