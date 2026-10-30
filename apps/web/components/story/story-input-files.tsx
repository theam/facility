"use client";

import { Button } from "@facility/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { clientApi } from "@/lib/client-api";
import { storyPath } from "./workspace-story-controls";

type InputFile = {
  id: string;
  name: string;
  size: number;
  sha256: string;
  state: string;
  errorCode: string | null;
};
type Inventory = { items: InputFile[]; limits: { fileBytes: number; messageFiles: number } };
type Prepared = { file: InputFile; upload: { path: string; headers: Record<string, string> } };

export function StoryInputFiles({
  projectId,
  storyId,
  selected,
  onChange,
  onBusy,
  disabled,
}: {
  projectId: string;
  storyId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
  onBusy: (busy: boolean) => void;
  disabled: boolean;
}) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [resume, setResume] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  const base = storyPath(projectId, storyId, "/input-files");
  const reload = useCallback(async () => {
    const result = await clientApi<Inventory>("GET", base);
    if (live.current) {
      if (result.ok) setInventory(result.data);
      else setError(result.message);
    }
  }, [base]);
  useEffect(() => {
    live.current = true;
    void reload();
    return () => {
      live.current = false;
    };
  }, [reload]);
  function setWorking(value: boolean) {
    setBusy(value);
    onBusy(value);
  }
  async function upload(files: FileList | null) {
    if (!files?.length || busy) return;
    setError("");
    setStatus("");
    setWorking(true);
    let selection = [...selected];
    try {
      for (const file of Array.from(files)) {
        if (selection.length >= 5) throw new Error("Attach at most five files to one message.");
        if (file.size < 1 || file.size > (inventory?.limits.fileBytes ?? 25 * 1024 * 1024))
          throw new Error("Files must be between 1 byte and 25 MiB.");
        setStatus(`Uploading ${file.name}…`);
        const bytes = await file.arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const sha256 = Array.from(new Uint8Array(digest), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        const prepared = await clientApi<Prepared>("POST", base, {
          name: file.name,
          size: file.size,
          sha256,
          mediaType: file.type || "application/octet-stream",
          resume,
          idempotency_key: `ui-file-${crypto.randomUUID()}`,
        });
        if (!prepared.ok) throw new Error(prepared.message);
        const result = await fetch(`/api${prepared.data.upload.path}`, {
          method: "PUT",
          headers: prepared.data.upload.headers,
          body: bytes,
        });
        const payload = await result.json();
        if (!result.ok)
          throw new Error(
            payload?.error?.message ?? "Upload failed. Reload file status before retrying.",
          );
        selection = [...selection, prepared.data.file.id];
        if (live.current) onChange(selection);
      }
      if (live.current)
        setStatus(
          "Files available. Send your message to deliver their references to the selected agent.",
        );
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : "File transfer failed");
    } finally {
      await reload();
      if (live.current) setWorking(false);
      else onBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  async function remove(file: InputFile) {
    if (
      !window.confirm(
        `Permanently delete ${file.name}? This may resume workspace compute and makes earlier references unavailable. It cannot erase an agent's previous context.`,
      )
    )
      return;
    setWorking(true);
    setError("");
    try {
      const result = await clientApi(
        "DELETE",
        `${base}/${encodeURIComponent(file.id)}?resume=true`,
      );
      if (!result.ok) throw new Error(result.message);
      onChange(selected.filter((id) => id !== file.id));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "File removal failed");
    } finally {
      setWorking(false);
    }
  }
  return (
    <section aria-label="Story input files" className="grid gap-2 border border-(--line) p-3">
      <label className="text-[12px]">
        Attach files (up to 25 MiB each; five per message)
        <input
          ref={input}
          type="file"
          multiple
          disabled={disabled || busy || !inventory}
          onChange={(event) => void upload(event.target.files)}
          className="mt-1 block w-full text-[12px]"
        />
      </label>
      <label className="flex items-center gap-2 text-[12px]">
        <input
          type="checkbox"
          checked={resume}
          disabled={disabled || busy}
          onChange={(e) => setResume(e.target.checked)}
        />
        Allow uploads to resume sleeping workspace compute
      </label>
      <p className="text-[12px] text-(--mut)">
        Private to this story, outside Git. Uploading does not run an agent or import knowledge.
        Available does not mean read. Downloads require a running workspace.
      </p>
      {!inventory && !error ? <p role="status">Loading input files…</p> : null}
      {inventory?.items.length === 0 ? (
        <p className="text-[12px] text-(--dim)">No input files yet.</p>
      ) : null}
      <ul className="grid gap-1">
        {inventory?.items.map((file) => (
          <li key={file.id} className="flex flex-wrap items-center gap-2 text-[12px]">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={selected.includes(file.id)}
                disabled={
                  disabled ||
                  busy ||
                  file.state !== "available" ||
                  (!selected.includes(file.id) && selected.length >= 5)
                }
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, file.id]
                      : selected.filter((id) => id !== file.id),
                  )
                }
              />
              {file.name}
            </label>
            <span>
              {file.size.toLocaleString()} bytes · {file.state}
            </span>
            {file.state === "available" ? (
              <a href={`/api${base}/${encodeURIComponent(file.id)}/content`} className="underline">
                download
              </a>
            ) : null}
            <Button
              type="button"
              size="sm"
              disabled={disabled || busy}
              onClick={() => void remove(file)}
            >
              delete file
            </Button>
          </li>
        ))}
      </ul>
      {selected.some(
        (id) => !inventory?.items.some((file) => file.id === id && file.state === "available"),
      ) && inventory ? (
        <p role="alert">
          A selected file is unavailable.{" "}
          <button
            type="button"
            onClick={() =>
              onChange(
                selected.filter((id) =>
                  inventory.items.some((file) => file.id === id && file.state === "available"),
                ),
              )
            }
          >
            Remove unavailable selections
          </button>
        </p>
      ) : null}
      {busy ? (
        <p role="status">{status || "Transferring files…"}</p>
      ) : status ? (
        <p role="status">{status}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px] text-(--bad)">
          {error}{" "}
          <button
            type="button"
            onClick={() => {
              setError("");
              void reload();
            }}
          >
            reload files
          </button>
        </p>
      ) : null}
    </section>
  );
}
