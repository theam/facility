export class PreviewLeaseLostError extends Error {
  readonly code = "preview_lease_lost";
}

export class PreviewComputeStopError extends Error {
  readonly code = "preview_compute_stop_unconfirmed";
}

/** Renew independently of long commands; stop compute before returning a lost lease. */
export async function withPreviewLease<T>(
  renew: () => Promise<Date | null>,
  work: (signal: AbortSignal) => Promise<T>,
  stop: () => Promise<unknown>,
) {
  const controller = new AbortController();
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let renewal: Promise<void> | undefined;
  let stopping: Promise<unknown> | undefined;
  let finished = false;
  const lose = () => {
    if (finished || controller.signal.aborted) return;
    controller.abort(new PreviewLeaseLostError("Preview writer authority was lost"));
    stopping = stop().catch((cause) => {
      throw new PreviewComputeStopError("Preview compute stop was not confirmed", { cause });
    });
    // The error is awaited after the command has stopped; avoid an unhandled rejection.
    void stopping.catch(() => undefined);
  };
  const tick = async () => {
    try {
      const expires = await renew();
      if (finished) return;
      if (!expires || expires.getTime() <= Date.now()) {
        lose();
        return;
      }
      const remaining = expires.getTime() - Date.now();
      if (deadline) clearTimeout(deadline);
      // Abort with time left to stop compute, even if the next DB renewal hangs.
      deadline = setTimeout(lose, Math.max(1, remaining * 0.75));
      heartbeat = setTimeout(
        () => {
          renewal = tick();
        },
        Math.max(1, Math.min(30_000, remaining / 3)),
      );
    } catch {
      lose();
    }
  };
  await tick();
  try {
    controller.signal.throwIfAborted();
    const result = await work(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (controller.signal.aborted)
      throw new PreviewLeaseLostError("Preview writer authority was lost");
    throw error;
  } finally {
    finished = true;
    if (heartbeat) clearTimeout(heartbeat);
    if (deadline) clearTimeout(deadline);
    // A slow DB call never holds up command cancellation or releases the writer.
    void renewal?.catch(() => undefined);
    if (stopping) await stopping;
  }
}
