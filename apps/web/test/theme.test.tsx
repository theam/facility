// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../components/shell/nav";
import { SignOutButton } from "../components/shell/sign-out";
import { AppearanceSetting } from "../components/theme/appearance-setting";
import { FirstThemeChoice } from "../components/theme/first-theme-choice";
import { ThemeChoice } from "../components/theme/theme-choice";
import { ThemeSync } from "../components/theme/theme-sync";
import { browserTheme, THEME_COOKIE, themeAttribute } from "../lib/theme";

const refresh = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push }),
  usePathname: () => "/projects",
}));

let container: HTMLDivElement, root: Root;
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  refresh.mockClear();
  push.mockClear();
  delete document.documentElement.dataset.theme;
  // biome-ignore lint/suspicious/noDocumentCookie: reset the browser's theme between tests
  document.cookie = `${THEME_COOKIE}=; Path=/; Max-Age=0`;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const answer = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
const radio = (value: string) =>
  container.querySelector(`input[type="radio"][value="${value}"]`) as HTMLInputElement;
async function click(element: Element | null) {
  await act(async () => (element as HTMLElement).click());
}
const sent = () =>
  fetchMock.mock.calls.map(([url, init]) => [url, init?.method, JSON.parse(init?.body ?? "null")]);

describe("theme helpers", () => {
  it("renders only explicit choices on <html>", () => {
    expect(themeAttribute("dark")).toBe("dark");
    expect(themeAttribute("light")).toBe("light");
    expect(themeAttribute("system")).toBeUndefined();
    expect(themeAttribute("sepia")).toBeUndefined();
    expect(themeAttribute(undefined)).toBeUndefined();
  });
});

describe("first visit", () => {
  it("previews each option live and saves the chosen one to the account", async () => {
    await act(async () => root.render(<FirstThemeChoice />));
    expect(container.querySelector("dialog")?.getAttribute("aria-labelledby")).toBe(
      "first-theme-title",
    );
    expect(radio("system").checked).toBe(true);
    await click(radio("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    // A preview is not a choice: nothing is remembered until it is saved.
    expect(browserTheme()).toBeNull();
    answer(200, { theme: "dark" });
    await click(
      [...container.querySelectorAll("button")].find((b) => /Save/.test(b.textContent ?? "")) ??
        null,
    );
    expect(sent()).toEqual([["/api/v1/me/preferences", "PATCH", { theme: "dark" }]]);
    expect(browserTheme()).toBe("dark");
    expect(refresh).toHaveBeenCalled();
  });

  it("keeps following the system when the person closes it", async () => {
    await act(async () => root.render(<FirstThemeChoice />));
    await click(radio("light"));
    answer(200, { theme: "system" });
    await act(async () => {
      container.querySelector("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(sent()).toEqual([["/api/v1/me/preferences", "PATCH", { theme: "system" }]]);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(browserTheme()).toBe("system");
  });

  it("stays open and explains a failure to save", async () => {
    await act(async () => root.render(<FirstThemeChoice />));
    answer(503, { error: { message: "control plane unavailable" } });
    await click(
      [...container.querySelectorAll("button")].find((b) => /Save/.test(b.textContent ?? "")) ??
        null,
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "control plane unavailable",
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(browserTheme()).toBeNull();
  });
});

describe("profile appearance", () => {
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

  it("previews at once and saves only where arrow keys stop", async () => {
    await act(async () => root.render(<AppearanceSetting initial="dark" saveDelayMs={10} />));
    expect(radio("dark").checked).toBe(true);
    answer(200, { theme: "light" });
    await click(radio("system"));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    await click(radio("light"));
    expect(document.documentElement.dataset.theme).toBe("light");
    // The group stays usable while a save is pending.
    expect(radio("dark").disabled).toBe(false);
    await settle();
    expect(sent()).toEqual([["/api/v1/me/preferences", "PATCH", { theme: "light" }]]);
    expect(browserTheme()).toBe("light");
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/saved/);
  });

  it("returns to the saved choice when the change is refused", async () => {
    await act(async () => root.render(<AppearanceSetting initial={null} saveDelayMs={0} />));
    expect(radio("system").checked).toBe(true);
    answer(403, { error: { message: "Only a signed-in person has preferences" } });
    await click(radio("dark"));
    await settle();
    expect(radio("system").checked).toBe(true);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(browserTheme()).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/signed-in person/);
  });

  it("keeps two choosers on one page independent", async () => {
    await act(async () =>
      root.render(
        <>
          <ThemeChoice value="dark" onChange={() => undefined} />
          <ThemeChoice value="light" onChange={() => undefined} />
        </>,
      ),
    );
    const names = new Set(
      [...container.querySelectorAll('input[type="radio"]')].map((input) =>
        input.getAttribute("name"),
      ),
    );
    expect(names.size).toBe(2);
    expect(
      [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
        .filter((input) => input.checked)
        .map((input) => input.value),
    ).toEqual(["dark", "light"]);
  });
});

describe("sign-out", () => {
  it("forgets this browser's theme so the next person starts from the system", async () => {
    document.documentElement.dataset.theme = "dark";
    // biome-ignore lint/suspicious/noDocumentCookie: the signed-in person's saved theme
    document.cookie = `${THEME_COOKIE}=dark; Path=/`;
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await act(async () => root.render(<SignOutButton />));
    await click(container.querySelector("button"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(browserTheme()).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(push).toHaveBeenCalledWith("/login");
  });
});

describe("browser sync", () => {
  it("applies the account's choice on a new device and forgets a previous person's", async () => {
    await act(async () => root.render(<ThemeSync theme="dark" />));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(browserTheme()).toBe("dark");
    await act(async () => root.render(<ThemeSync theme={null} />));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(browserTheme()).toBeNull();
  });
});

describe("navigation", () => {
  it("offers the profile next to the organization settings", () => {
    const element = document.createElement("div");
    element.innerHTML = renderToStaticMarkup(<Sidebar />);
    expect(
      [...element.querySelectorAll('nav[aria-label="Platform"] a')].map((a) => [
        a.textContent,
        a.getAttribute("href"),
      ]),
    ).toEqual([
      ["Organization settings", "/settings"],
      ["Your profile", "/profile"],
    ]);
  });
});
