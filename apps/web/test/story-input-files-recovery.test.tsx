// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoryInputFiles } from "../components/story/story-input-files";
import type { StoryWorkspace } from "../lib/api";
import type { StoryUploadAttempt } from "../lib/story-upload";

vi.mock("../components/story/workspace-story-controls", () => ({
  storyPath: (p: string, s: string, suffix: string) =>
    `/v1/projects/${p}/workspace-stories/${s}${suffix}`,
}));
const base = "/v1/projects/p/workspace-stories/s/input-files";
const content = "fixture";
let container: HTMLDivElement, root: Root;
let onChange: ReturnType<typeof vi.fn<(ids: string[]) => void>>;
let onAttempt: ReturnType<typeof vi.fn<(attempt?: StoryUploadAttempt) => void>>;
let onBusy: ReturnType<typeof vi.fn<(busy: boolean) => void>>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onChange = vi.fn();
  onAttempt = vi.fn();
  onBusy = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Harness({
  original,
  computeState,
}: {
  original?: StoryUploadAttempt;
  computeState?: StoryWorkspace["state"];
}) {
  const [attempt, setAttempt] = useState(original),
    [selected, setSelected] = useState<string[]>([]);
  return (
    <StoryInputFiles
      projectId="p"
      storyId="s"
      selected={selected}
      attempt={attempt}
      computeState={computeState}
      disabled={false}
      onChange={(ids) => {
        onChange(ids);
        setSelected(ids);
      }}
      onBusy={onBusy}
      onAttempt={(next) => {
        onAttempt(next);
        setAttempt(next);
      }}
    />
  );
}
async function mount(original?: StoryUploadAttempt, computeState?: StoryWorkspace["state"]) {
  await act(async () => root.render(<Harness original={original} computeState={computeState} />));
}
async function choose(text = content, waitForCompletion = true) {
  const file = new File([text], "fixture.txt", { type: "text/plain" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode(text).buffer,
  });
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw Error("Missing file picker");
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  onBusy.mockClear();
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      waitForCompletion
        ? expect(onBusy).toHaveBeenLastCalledWith(false)
        : expect(onAttempt).toHaveBeenCalled(),
    );
  });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  if (!button) throw Error(`Missing ${label}`);
  await act(async () => button.click());
}
type Row = {
  id: string;
  name: string;
  size: number;
  sha256: string;
  state: string;
  errorCode: string | null;
  key: string;
};
function server(loss: "prepare" | "transfer" | "none" = "none") {
  const rows: Row[] = [],
    bodies: Record<string, unknown>[] = [];
  let dropped = false,
    puts = 0;
  const control = {
    denyReads: false,
    hideReceipt: false,
    denyPrepare: false,
    destination: "",
    forcedState: "",
    expired: false,
    waitPreparation: null as Promise<void> | null,
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        name: string;
        size: number;
        sha256: string;
        idempotency_key: string;
        resume: boolean;
        mediaType: string;
      };
      bodies.push(body);
      if (control.denyPrepare)
        return Response.json({ error: { message: "Permission denied" } }, { status: 403 });
      let row = rows.find((item) => item.key === body.idempotency_key);
      if (!row) {
        row = {
          ...body,
          key: body.idempotency_key,
          id: `infile_${String(rows.length + 1).padStart(16, "0")}`,
          state: "prepared",
          errorCode: null,
        };
        rows.push(row);
      }
      if (loss === "prepare" && !dropped) {
        dropped = true;
        throw Error("Response lost after preparation");
      }
      if (control.waitPreparation) await control.waitPreparation;
      return Response.json({
        file: { ...row, state: control.forcedState || row.state },
        upload: {
          path: control.destination || `${base}/${row.id}/content`,
          headers: {
            "content-type": "application/octet-stream",
            "x-facility-file-token": "synthetic",
          },
          expiresAt: new Date(Date.now() + (control.expired ? -1000 : 600000)).toISOString(),
        },
      });
    }
    if (init?.method === "PUT") {
      puts++;
      const row = rows.find((item) => url.endsWith(`${item.id}/content`));
      if (row?.state !== "prepared")
        return Response.json({ error: { message: "Consumed grant" } }, { status: 409 });
      row.state = "available";
      if (loss === "transfer" && !dropped) {
        dropped = true;
        if (control.hideReceipt) control.denyReads = true;
        throw Error("Response lost after transfer");
      }
      return Response.json({ file: row });
    }
    if (control.denyReads)
      return Response.json({ error: { message: "Metadata unavailable" } }, { status: 503 });
    return Response.json({ items: rows, limits: { fileBytes: 26214400, messageFiles: 5 } });
  });
  vi.stubGlobal("fetch", fetch);
  return { rows, bodies, control, fetch, puts: () => puts };
}

describe("recovering the original upload", () => {
  it("does not transfer bytes or overwrite a new view after leaving during preparation", async () => {
    const api = server();
    let release: () => void = () => {};
    api.control.waitPreparation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mount();
    await choose(content, false);
    expect(api.bodies).toHaveLength(1);
    const stored = onAttempt.mock.calls[0]?.[0];
    if (!stored) throw Error("Missing original upload intent");
    expect(stored?.idempotencyKey).toBe(api.bodies[0]?.idempotency_key);
    await act(async () => root.unmount());
    root = createRoot(container);
    onAttempt.mockClear();
    onChange.mockClear();
    await mount({
      ...stored,
      name: "another-story.txt",
      idempotencyKey: `ui-file-${crypto.randomUUID()}`,
    });
    await act(async () => {
      release();
      await vi.waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false));
    });
    expect(api.puts()).toBe(0);
    expect(onAttempt).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Original upload: another-story.txt");
  });
  it("recovers a lost preparation with the same identity and resume choice, then transfers once", async () => {
    const api = server("prepare");
    await mount(undefined, "sleeping");
    await click("Resume and upload files");
    await choose();
    expect(api.rows).toHaveLength(1);
    expect(api.puts()).toBe(0);
    expect(container.textContent).toContain("Resolve this attempt before sending");
    await click("Recover original attempt");
    expect(api.puts()).toBe(0);
    expect(api.rows).toHaveLength(1);
    expect(container.textContent).toContain("Choose the original file");
    await mount(undefined, "running");
    await click("Resume and continue upload");
    await choose();
    expect(api.rows).toHaveLength(1);
    expect(api.puts()).toBe(1);
    expect(new Set(api.bodies.map((body) => body.idempotency_key)).size).toBe(1);
    expect(api.bodies.every((body) => body.resume === true)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith([api.rows[0]?.id]);
    expect(onAttempt).toHaveBeenLastCalledWith(undefined);
    expect(api.fetch.mock.calls.some(([url]) => url.endsWith("/messages"))).toBe(false);
  });
  it.each([
    ["running", "Upload files", false, "sleeping"],
    ["sleeping", "Resume and upload files", true, "running"],
    [undefined, "Upload without resuming", false, "sleeping"],
    [undefined, "Resume if needed and upload", true, "running"],
    ["error", "Resume if needed and upload", true, "running"],
  ] as const)("binds %s / %s before opening the picker even if compute changes", async (state, label, resume, nextState) => {
    const api = server();
    await mount(undefined, state);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!picker) throw Error("Missing file picker");
    const opened = vi.spyOn(picker, "click");
    await click(label);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(api.bodies).toHaveLength(0);
    expect(api.puts()).toBe(0);
    expect(onAttempt).not.toHaveBeenCalled();
    await mount(undefined, nextState);
    await choose();
    expect(api.bodies).toHaveLength(1);
    expect(api.bodies[0]?.resume).toBe(resume);
    expect(api.puts()).toBe(1);
  });
  it.each([
    "creating",
    "deleting",
    "destroyed",
  ] as const)("keeps %s metadata readable without offering an upload", async (state) => {
    const api = server();
    await mount(undefined, state);
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Upload unavailable",
    );
    expect(button?.disabled).toBe(true);
    expect(container.textContent).toContain(`compute is ${state}`);
    expect(api.bodies).toHaveLength(0);
    expect(api.puts()).toBe(0);
    expect(api.fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
  it("uses observed availability after a lost transfer result without replaying its consumed grant", async () => {
    const api = server("transfer");
    await mount();
    await choose();
    expect(api.rows).toHaveLength(1);
    expect(api.puts()).toBe(1);
    expect(api.bodies).toHaveLength(1);
    expect(onChange).toHaveBeenLastCalledWith([api.rows[0]?.id]);
    expect(onAttempt).toHaveBeenLastCalledWith(undefined);
    expect(container.textContent).toContain("Files available");
    expect(container.querySelector('[aria-label="Unfinished upload"]')).toBeNull();
  });
  it("keeps an uncertain transfer unresolved across read failures and reconciles by read only", async () => {
    const api = server("transfer");
    api.control.hideReceipt = true;
    await mount();
    await choose();
    expect(onChange).not.toHaveBeenCalled();
    await click("Check upload status");
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("No input files yet");
    expect(container.textContent).toContain("Previous entries may be outdated");
    expect(api.puts()).toBe(1);
    expect(api.bodies).toHaveLength(1);
    api.control.denyReads = false;
    await click("Check upload status");
    expect(onChange).toHaveBeenLastCalledWith([api.rows[0]?.id]);
    expect(api.puts()).toBe(1);
    expect(api.bodies).toHaveLength(1);
  });
  it("rejects a different file under the original intent and requires an explicit fresh attempt", async () => {
    const api = server("prepare");
    await mount();
    await choose();
    const first = api.bodies[0]?.idempotency_key;
    await choose("changed fixture");
    expect(api.bodies).toHaveLength(1);
    expect(api.puts()).toBe(0);
    expect(container.textContent).toContain("choosing a different file");
    await click("Continue without this file");
    expect(api.rows).toHaveLength(1);
    expect(api.puts()).toBe(0);
    await choose("changed fixture");
    expect(api.rows).toHaveLength(2);
    expect(api.bodies[1]?.idempotency_key).not.toBe(first);
    expect(api.puts()).toBe(1);
  });
  it.each([
    "uploading",
    "failed",
    "removed",
  ])("does not transfer or select a %s reservation", async (state) => {
    const api = server();
    api.control.forcedState = state;
    await mount();
    await choose();
    expect(api.puts()).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Unfinished upload"]')).not.toBeNull();
  });
  it.each([
    "destination",
    "expired",
    "denied",
  ])("does not send bytes when the %s check fails", async (reason) => {
    const api = server();
    if (reason === "destination")
      api.control.destination =
        "/v1/projects/other/workspace-stories/s/input-files/infile_0123456789abcdef/content";
    if (reason === "expired") api.control.expired = true;
    if (reason === "denied") api.control.denyPrepare = true;
    await mount();
    await choose();
    expect(api.puts()).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
  it("reads a restored exact file without preparing a new reservation", async () => {
    const api = server();
    const original: StoryUploadAttempt = {
      idempotencyKey: `ui-file-${crypto.randomUUID()}`,
      name: "fixture.txt",
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      mediaType: "text/plain",
      resume: false,
      fileId: "infile_0123456789abcdef",
    };
    if (!original.fileId) throw Error("Missing restored file ID");
    api.rows.push({
      ...original,
      id: original.fileId,
      key: original.idempotencyKey,
      state: "available",
      errorCode: null,
    });
    await mount(original);
    await click("Check upload status");
    expect(api.bodies).toHaveLength(0);
    expect(api.puts()).toBe(0);
    expect(onChange).toHaveBeenLastCalledWith([original.fileId]);
  });
});
