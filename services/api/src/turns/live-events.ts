import type { AgentTurnEvent } from "./engines.js";

/** A single writer preserves event order and retries the uncommitted prefix. */
export class LiveTurnEvents {
  private readonly pending: AgentTurnEvent[] = [];
  private writing?: Promise<void>;
  private persisted = 0;
  private failure?: unknown;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly write: (events: AgentTurnEvent[], firstIndex: number) => Promise<void>,
    private readonly turnId?: string,
  ) {
    this.timer = setInterval(() => void this.flush(), 1_000);
    this.timer.unref();
  }

  append(event: AgentTurnEvent) {
    this.pending.push(event);
    if (this.pending.length === 1) void this.flush();
  }

  private flush(): Promise<void> {
    if (this.writing) return this.writing;
    this.writing = (async () => {
      while (this.pending.length) {
        const batch = this.pending.slice(0, 100);
        try {
          await this.write(batch, this.persisted);
        } catch (error) {
          if (this.failure === undefined)
            console.warn(
              JSON.stringify({
                event: "turn.events_persistence_failed",
                turnId: this.turnId,
                pendingEvents: this.pending.length,
              }),
            );
          this.failure = error;
          return;
        }
        this.failure = undefined;
        this.pending.splice(0, batch.length);
        this.persisted += batch.length;
      }
    })().finally(() => {
      this.writing = undefined;
    });
    return this.writing;
  }

  /** Reconcile adapters that return events without streaming them; never replay a saved prefix. */
  async finish(events: AgentTurnEvent[] = []) {
    clearInterval(this.timer);
    await this.flush();
    const received = this.persisted + this.pending.length;
    this.pending.push(...events.slice(received));
    await this.flush();
    if (this.pending.length) throw this.failure ?? new Error("Turn events could not be saved");
  }
}
