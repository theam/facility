// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoryInputFiles } from "../components/story/story-input-files";

vi.mock("../components/story/workspace-story-controls", () => ({
  storyPath: (p: string, s: string, suffix: string) =>
    `/v1/projects/${p}/workspace-stories/${s}${suffix}`,
}));
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("story input files UI", () => {
  it("shows empty/error states without inference or compute mutation", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ items: [], limits: { fileBytes: 26214400, messageFiles: 5 } }),
      );
    vi.stubGlobal("fetch", fetch);
    await act(async () =>
      root.render(
        <StoryInputFiles
          projectId="p"
          storyId="s"
          selected={[]}
          onChange={() => {}}
          onBusy={() => {}}
          disabled={false}
        />,
      ),
    );
    expect(container.textContent).toContain("No input files yet");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(
      false,
    );
  });
  it("uploads bytes over HTTP, selects only available IDs and labels availability honestly", async () => {
    const id = "infile_0123456789abcdef";
    const fileInfo = {
      id,
      name: "fixture.json",
      size: 13,
      sha256: "a".repeat(64),
      state: "available",
      errorCode: null,
    };
    const onChange = vi.fn(),
      onBusy = vi.fn();
    let complete = false;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return Response.json({
          file: { ...fileInfo, state: "prepared" },
          upload: {
            path: "/v1/synthetic-content",
            headers: {
              "content-type": "application/octet-stream",
              "x-facility-file-token": "synthetic",
            },
          },
        });
      if (init?.method === "PUT") {
        complete = true;
        return Response.json({ file: fileInfo });
      }
      return Response.json({
        items: complete ? [fileInfo] : [],
        limits: { fileBytes: 26214400, messageFiles: 5 },
      });
    });
    vi.stubGlobal("fetch", fetch);
    await act(async () =>
      root.render(
        <StoryInputFiles
          projectId="p"
          storyId="s"
          selected={[]}
          onChange={onChange}
          onBusy={onBusy}
          disabled={false}
        />,
      ),
    );
    const file = new File(['{"fixture":1}'], "fixture.json", { type: "application/json" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode('{"fixture":1}').buffer,
    });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith([id]));
    });
    const binary = fetch.mock.calls.find(([, init]) => init?.method === "PUT")?.[1]
      ?.body as ArrayBuffer;
    expect(new TextDecoder().decode(binary)).toBe('{"fixture":1}');
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/messages"))).toBe(false);
    expect(onChange).toHaveBeenCalledWith([id]);
    expect(onBusy).toHaveBeenLastCalledWith(false);
    expect(container.textContent).toContain("Files available");
    expect(container.textContent).toContain("does not mean read");
  });
  it("reports denied input metadata without offering to bypass permissions", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: { message: "Permission denied" } }, { status: 403 }),
        ),
    );
    await act(async () =>
      root.render(
        <StoryInputFiles
          projectId="p"
          storyId="s"
          selected={[]}
          onChange={() => {}}
          onBusy={() => {}}
          disabled={false}
        />,
      ),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Permission denied");
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
  });
});
