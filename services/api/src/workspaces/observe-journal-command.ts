import { setTimeout as delay } from "node:timers/promises";
import type { Command, Session } from "@vercel/sandbox";
import { COMMAND_JOURNAL_SEGMENT_BYTES, CommandJournal } from "./command-journal.js";
import { CommandReadObserver, isTransientObservationError } from "./command-observation.js";
import type { CommandObservation, WorkspaceCommandOutput } from "./runtime.js";

/** Streaming and recovery consume the same sequenced events from the original command. */
export async function observeJournalCommand(input: {
  command: Command;
  session: Pick<Session, "readFileToBuffer">;
  path: string;
  signal: AbortSignal;
  onOutput: (output: WorkspaceCommandOutput) => void;
  onObservation: (event: CommandObservation) => void;
}) {
  let deliveryFailed = false;
  const journal = new CommandJournal((output) => {
    try {
      input.onOutput(output);
    } catch (error) {
      deliveryFailed = true;
      throw error;
    }
  });
  const streamDone = new AbortController();
  const waitDone = new AbortController();
  const notify = (event: CommandObservation) =>
    input.onObservation({ ...event, nextSequence: journal.nextSequence });
  const reads = new CommandReadObserver(input.signal, notify);
  const waits = new CommandReadObserver(AbortSignal.any([input.signal, waitDone.signal]), notify);
  let metadata: { exitCode: number; durationMs: number } | undefined;
  let streamInterruptedAt: number | undefined;

  const completion = (async () => {
    try {
      const result = await waits.read("completion", (signal) => input.command.wait({ signal }));
      metadata = { exitCode: result.exitCode, durationMs: result.durationMs ?? 0 };
      streamDone.abort();
    } catch (error) {
      // A persisted exit event also proves completion if the metadata endpoint is unavailable.
      if (!waitDone.signal.aborted || !journal.result) throw error;
    }
  })();

  const output = (async () => {
    try {
      for await (const log of input.command.logs({
        signal: AbortSignal.any([input.signal, streamDone.signal]),
      })) {
        input.signal.throwIfAborted();
        if (log.stream === "stdout") journal.push(log.data);
        if (journal.result) break;
      }
    } catch (error) {
      input.signal.throwIfAborted();
      if (deliveryFailed || journal.result) throw error;
      const failure = error as { status?: number; response?: { status?: number } };
      const status = failure?.status ?? failure?.response?.status;
      if (status !== undefined && !isTransientObservationError(error)) throw error;
      // Provider replay can be truncated or start mid-frame; the journal is authoritative.
      if (!streamDone.signal.aborted) {
        streamInterruptedAt = Date.now();
        notify({
          state: "recovering",
          operation: "logs",
          attempt: 0,
          elapsedMs: 0,
          reason: "read_failed",
        });
      }
    }

    let segment = 0;
    while (!journal.result) {
      const data = await reads.read("journal", (signal) =>
        input.session.readFileToBuffer({ path: `${input.path}.${segment}` }, { signal }),
      );
      if (data) {
        journal.restart();
        journal.push(data.toString("utf8"));
        if (streamInterruptedAt !== undefined) {
          notify({
            state: "recovered",
            operation: "logs",
            attempt: 0,
            elapsedMs: Date.now() - streamInterruptedAt,
          });
          streamInterruptedAt = undefined;
        }
        if (data.length >= COMMAND_JOURNAL_SEGMENT_BYTES && data.at(-1) === 10 && !journal.result) {
          segment += 1;
          continue;
        }
      }
      if (journal.result) break;
      if (metadata) {
        // The wrapper may itself be killed before it can persist an exit frame.
        if (metadata.exitCode !== 0) break;
        throw new Error("Completed command journal is missing its exit event");
      }
      await delay(2_000, undefined, { signal: input.signal });
    }
    journal.finish();
    waitDone.abort();
  })();

  try {
    await Promise.all([output, completion]);
    input.signal.throwIfAborted();
    if (journal.result && metadata && journal.result.exitCode !== metadata.exitCode) {
      throw new Error("Command exit event disagrees with provider completion");
    }
    const result = journal.result ?? metadata;
    if (!result) throw new Error("Command completion is unavailable");
    return result;
  } finally {
    streamDone.abort();
    waitDone.abort();
  }
}
