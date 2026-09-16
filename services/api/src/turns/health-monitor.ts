import type { WorkspaceDiagnostics } from "../workspaces/diagnostics.js";

/** Provider probes are bounded and never wake compute or overlap. */
export class TurnHealthMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private stopped = false;
  private missedSamples = 0;
  private probeInFlight = false;

  constructor(
    private readonly inspect: (signal: AbortSignal) => Promise<WorkspaceDiagnostics>,
    private readonly save: (data: Record<string, unknown>) => Promise<void>,
    private readonly turnId?: string,
  ) {}

  start() {
    void this.sample();
    this.timer = setInterval(() => void this.sample(), 30_000);
    this.timer.unref();
  }

  sample(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.stopped || this.probeInFlight) return Promise.resolve();
    this.pending = (async () => {
      const started = Date.now();
      const signal = AbortSignal.timeout(8_000);
      let observation: Record<string, unknown>;
      try {
        // Bound even an adapter that does not honor cancellation.
        const unavailable = new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        this.probeInFlight = true;
        const probe = Promise.resolve()
          .then(() => this.inspect(signal))
          .finally(() => {
            this.probeInFlight = false;
          });
        observation = await Promise.race([probe, unavailable]);
      } catch {
        observation = { probe: "unavailable" };
      }
      try {
        await this.save({
          ...observation,
          sampledAt: new Date(started).toISOString(),
          durationMs: Date.now() - started,
          missedSamples: this.missedSamples,
        });
        this.missedSamples = 0;
      } catch {
        this.missedSamples += 1;
        console.warn(
          JSON.stringify({
            event: "turn.health_persistence_failed",
            turnId: this.turnId,
            missedSamples: this.missedSamples,
          }),
        );
      }
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.pending;
  }
}
