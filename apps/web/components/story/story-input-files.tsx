"use client";

import { Button } from "@facility/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { clientApi } from "@/lib/client-api";
import type { StoryUploadAttempt } from "@/lib/story-upload";
import { storyPath } from "./workspace-story-controls";

type InputFile = {
  id: string;
  name: string;
  size: number;
  sha256: string;
  state: string;
  errorCode: string | null;
  expiresAt?: string;
};
type Inventory = { items: InputFile[]; limits: { fileBytes: number; messageFiles: number } };
type Prepared = {
  file: InputFile;
  upload: { path: string; headers: Record<string, string>; expiresAt?: string };
};

function matches(file: Pick<InputFile, "name" | "size" | "sha256">, attempt: StoryUploadAttempt) {
  return file.name === attempt.name && file.size === attempt.size && file.sha256 === attempt.sha256;
}
function sizeLabel(bytes: number) {
  return bytes % (1024 * 1024) === 0
    ? `${bytes / (1024 * 1024)} MiB`
    : `${bytes.toLocaleString()} bytes`;
}
function stateLabel(file: InputFile) {
  if (file.state === "prepared")
    return file.expiresAt && Date.parse(file.expiresAt) <= Date.now()
      ? "Upload expired"
      : "Ready for transfer";
  if (file.state === "uploading") return "Transfer awaiting a result";
  if (file.state === "failed") return "Upload failed";
  return file.state;
}

export function StoryInputFiles({
  projectId,
  storyId,
  selected,
  onChange,
  onBusy,
  disabled,
  attempt,
  attemptSaved = false,
  onAttempt,
}: {
  projectId: string;
  storyId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
  onBusy: (busy: boolean) => void;
  disabled: boolean;
  attempt?: StoryUploadAttempt;
  attemptSaved?: boolean;
  onAttempt: (attempt?: StoryUploadAttempt) => void;
}) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [metadataError, setMetadataError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [resume, setResume] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  const working = useRef(false);
  const reads = useRef(0);
  const base = storyPath(projectId, storyId, "/input-files");
  const maxFiles = inventory?.limits.messageFiles ?? 5;
  const maxBytes = inventory?.limits.fileBytes ?? 25 * 1024 * 1024;
  const reload = useCallback(async () => {
    const sequence = ++reads.current;
    const result = await clientApi<Inventory>("GET", base);
    if (live.current && sequence === reads.current) {
      if (result.ok) {
        setInventory(result.data);
        setMetadataError("");
      } else setMetadataError(result.message);
    }
    return result.ok ? result.data : null;
  }, [base]);
  useEffect(() => {
    live.current = true;
    void reload();
    return () => {
      live.current = false;
      reads.current++;
    };
  }, [reload]);

  function setWorking(value: boolean) {
    working.current = value;
    if (live.current) setBusy(value);
    onBusy(value);
  }
  function remember(value: StoryUploadAttempt) {
    if (live.current) onAttempt(value);
    return value;
  }
  function accept(file: InputFile, original: StoryUploadAttempt, selection: string[]) {
    if (file.id !== original.fileId || !matches(file, original) || file.state !== "available")
      throw new Error(
        "The original file is not verified as available. Check its status before retrying.",
      );
    const next = [...new Set([...selection, file.id])];
    if (next.length > maxFiles)
      throw new Error(`Select at most ${maxFiles} files for this message.`);
    if (live.current) {
      onChange(next);
      onAttempt();
      setError("");
      setStatus(
        "Files available. Send your message to deliver their references to the selected agent.",
      );
    }
    return next;
  }
  async function prepare(original: StoryUploadAttempt) {
    const result = await clientApi<Prepared>("POST", base, {
      name: original.name,
      size: original.size,
      sha256: original.sha256,
      mediaType: original.mediaType,
      resume: original.resume,
      idempotency_key: original.idempotencyKey,
    });
    if (!result.ok) throw new Error(result.message);
    const prepared = result.data;
    if (
      !prepared?.file ||
      !/^infile_[a-z0-9]{16,64}$/.test(prepared.file.id) ||
      !matches(prepared.file, original) ||
      (original.fileId && original.fileId !== prepared.file.id)
    )
      throw new Error(
        "The upload response does not match the original file. No bytes were transferred.",
      );
    return prepared;
  }
  function explain(file: InputFile | undefined) {
    if (!file)
      return "The original file is not in the current inventory. Check again or continue without it.";
    if (file.state === "prepared")
      return file.expiresAt && Date.parse(file.expiresAt) <= Date.now()
        ? "The upload expired. Continue without this attempt before starting a new upload; its reservation remains until deleted."
        : "Choose the original file to continue this upload. Its name, size and content must match.";
    if (file.state === "uploading")
      return "The original transfer has no final result yet. Check again; no second transfer has been started.";
    return "This upload is unavailable. Continue without this attempt before starting another; its reservation remains until deleted.";
  }
  async function recover() {
    if (!attempt || disabled || working.current) return;
    setWorking(true);
    setError("");
    setStatus(`Checking the original upload of ${attempt.name}…`);
    try {
      let original = attempt;
      let file: InputFile | undefined;
      if (!original.fileId) {
        const prepared = await prepare(original);
        if (!live.current) return;
        original = remember({ ...original, fileId: prepared.file.id });
        file = prepared.file;
      } else {
        const current = await reload();
        if (!current)
          throw new Error("File status could not be read. Check again before retrying.");
        file = current.items.find((item) => item.id === original.fileId);
      }
      if (!live.current) return;
      if (file?.state === "available") accept(file, original, selected);
      else setStatus(explain(file));
    } catch (e) {
      if (live.current) {
        setStatus("");
        setError(e instanceof Error ? e.message : "File status could not be read");
      }
    } finally {
      if (live.current) await reload();
      setWorking(false);
    }
  }
  async function upload(files: FileList | null) {
    if (!files?.length || disabled || working.current || !inventory || metadataError) return;
    setError("");
    setStatus("");
    setWorking(true);
    let selection = [...selected];
    let original = attempt;
    let transferPending = false;
    try {
      for (const file of Array.from(files)) {
        if (selection.length >= maxFiles)
          throw new Error(`Attach at most ${maxFiles} files to one message.`);
        if (file.size < 1 || file.size > maxBytes)
          throw new Error(`Files must be between 1 byte and ${sizeLabel(maxBytes)}.`);
        setStatus(`Checking ${file.name}…`);
        const bytes = await file.arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        if (!live.current) return;
        const metadata = {
          name: file.name,
          size: file.size,
          sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
            "",
          ),
          mediaType: file.type || "application/octet-stream",
        };
        if (original && (!matches(metadata, original) || metadata.mediaType !== original.mediaType))
          throw new Error(
            "Resolve the original upload or continue without it before choosing a different file.",
          );
        original ??= remember({
          ...metadata,
          resume,
          idempotencyKey: `ui-file-${crypto.randomUUID()}`,
        });
        setStatus(`Preparing ${file.name}…`);
        const prepared = await prepare(original);
        if (!live.current) return;
        original = remember({ ...original, fileId: prepared.file.id });
        if (prepared.file.state === "available") {
          selection = accept(prepared.file, original, selection);
          original = undefined;
          continue;
        }
        if (prepared.file.state !== "prepared") throw new Error(explain(prepared.file));
        if (prepared.upload.expiresAt && Date.parse(prepared.upload.expiresAt) <= Date.now())
          throw new Error(
            "The upload grant expired. Continue without this attempt before starting a new upload.",
          );
        if (prepared.upload.path !== `${base}/${encodeURIComponent(prepared.file.id)}/content`)
          throw new Error(
            "The transfer destination does not match this story's file. No bytes were transferred.",
          );
        setStatus(
          `Transferring ${file.name}…${original.resume ? " Sleeping workspace compute may resume." : ""}`,
        );
        transferPending = true;
        const result = await fetch(`/api${prepared.upload.path}`, {
          method: "PUT",
          headers: prepared.upload.headers,
          body: bytes,
        });
        const payload = await result.json().catch(() => null);
        if (!result.ok || !payload?.file)
          throw new Error(
            payload?.error?.message ?? "Transfer result unavailable. Checking the original file.",
          );
        selection = accept(payload.file, original, selection);
        original = undefined;
        transferPending = false;
      }
    } catch (e) {
      if (!live.current) return;
      setStatus("");
      setError(e instanceof Error ? e.message : "File transfer failed");
      // A consumed grant is never replayed. Reconcile the exact file after a lost result.
      if (transferPending && original?.fileId) {
        const current = await reload();
        const file = current?.items.find((item) => item.id === original?.fileId);
        if (live.current && file?.state === "available") {
          try {
            accept(file, original, selection);
          } catch (error) {
            setError(error instanceof Error ? error.message : "File verification failed");
          }
        }
      }
    } finally {
      if (live.current) await reload();
      setWorking(false);
      if (input.current) input.current.value = "";
    }
  }
  async function remove(file: InputFile) {
    if (
      disabled ||
      working.current ||
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
      if (live.current) {
        onChange(selected.filter((id) => id !== file.id));
        if (attempt?.fileId === file.id) onAttempt();
        await reload();
      }
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : "File removal failed");
    } finally {
      setWorking(false);
    }
  }
  return (
    <section aria-label="Story input files" className="grid gap-3 border border-(--line) p-3">
      <label className="min-w-0 text-[12px]">
        {attempt
          ? "Choose the original file to continue"
          : `Attach files (up to ${sizeLabel(maxBytes)} each; ${maxFiles} per message)`}
        <input
          ref={input}
          type="file"
          multiple={!attempt}
          disabled={disabled || busy || !inventory || Boolean(metadataError)}
          onChange={(event) => void upload(event.target.files)}
          className="mt-2 block min-h-11 w-full min-w-0 text-[12px] file:mr-3 file:min-h-11 file:cursor-pointer file:border file:border-(--line) file:bg-(--bg-subtle) file:px-3 file:text-(--ink)"
        />
      </label>
      <label className="flex min-h-11 items-center gap-2 text-[12px]">
        <input
          type="checkbox"
          checked={attempt?.resume ?? resume}
          disabled={disabled || busy || Boolean(attempt)}
          onChange={(e) => setResume(e.target.checked)}
        />
        Allow uploads to resume sleeping workspace compute
      </label>
      <p className="text-[12px] text-(--mut)">
        Private to this story, outside Git. Uploading does not run an agent or import knowledge.
        Available does not mean read. Downloads require a running workspace.
      </p>
      {attempt ? (
        <section
          aria-label="Unfinished upload"
          className="grid gap-2 border-l-2 border-(--human) pl-3 text-[12px]"
        >
          <p className="wrap-anywhere">
            Original upload: {attempt.name}. Resolve this attempt before sending the message.
          </p>
          <p className="text-(--mut)">
            {attemptSaved
              ? "The original intent is kept in this tab for up to 24 hours. "
              : "Keep this page open to preserve the original intent. "}
            File contents and transfer credentials are not saved in the browser. Checking the
            original attempt does not transfer bytes or resume compute.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={disabled || busy}
              onClick={() => void recover()}
            >
              {attempt.fileId ? "Check upload status" : "Recover original attempt"}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={disabled || busy}
              onClick={() => {
                onAttempt();
                setError("");
                setStatus(
                  "Continuing without this file. Stored files and reservations remain in the inventory until explicitly deleted.",
                );
              }}
            >
              Continue without this file
            </Button>
          </div>
        </section>
      ) : null}
      {!inventory && !metadataError ? <p role="status">Loading input files…</p> : null}
      {metadataError && inventory ? (
        <p className="text-[12px] text-(--human)">
          File inventory could not be refreshed. Previous entries may be outdated.
        </p>
      ) : null}
      {inventory?.items.length === 0 && !metadataError && !busy && !attempt ? (
        <p className="text-[12px] text-(--dim)">No input files yet.</p>
      ) : null}
      <ul className="grid gap-1">
        {inventory?.items.map((file) => (
          <li key={file.id} className="flex min-w-0 flex-wrap items-center gap-2 text-[12px]">
            <label className="flex min-h-11 min-w-0 items-center gap-2">
              <input
                type="checkbox"
                checked={selected.includes(file.id)}
                disabled={
                  disabled ||
                  busy ||
                  Boolean(metadataError) ||
                  file.state !== "available" ||
                  (!selected.includes(file.id) && selected.length >= maxFiles)
                }
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, file.id]
                      : selected.filter((id) => id !== file.id),
                  )
                }
              />
              <span className="wrap-anywhere">{file.name}</span>
            </label>
            <span>
              {file.size.toLocaleString()} bytes · {stateLabel(file)}
            </span>
            {file.state === "available" ? (
              <a
                href={`/api${base}/${encodeURIComponent(file.id)}/content`}
                className="inline-flex min-h-11 items-center underline"
              >
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
      ) &&
      inventory &&
      !metadataError ? (
        <p role="alert">
          A selected file is unavailable.{" "}
          <button
            type="button"
            disabled={disabled || busy}
            className="min-h-11 underline"
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
      {status ? (
        <p role="status" className="wrap-anywhere text-[12px]">
          {status}
        </p>
      ) : null}
      {error || metadataError ? (
        <p role="alert" className="wrap-anywhere text-[12px] text-(--bad)">
          {error || metadataError}{" "}
          <button
            type="button"
            disabled={busy}
            className="min-h-11 underline"
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
