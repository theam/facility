/** Keep lease failures observable without logging database errors or flooding job logs. */
export class TurnLeaseHeartbeat {
  private readonly timer: ReturnType<typeof setInterval>;
  private pending = false;
  private stopped = false;
  private lastConfirmed = Date.now();
  private lastWarning?: number;
  private failures = 0;

  constructor(
    private readonly renew: () => Promise<boolean>,
    private readonly lost: () => void,
    private readonly turnId: string,
  ) {
    this.timer = setInterval(() => void this.tick(), 2_000);
    this.timer.unref();
  }

  private warn(reason: "write_failed" | "write_pending") {
    const now = Date.now();
    if (this.lastWarning !== undefined && now - this.lastWarning < 30_000) return;
    this.lastWarning = now;
    console.warn(
      JSON.stringify({
        event: "turn.heartbeat_unconfirmed",
        turnId: this.turnId,
        reason,
        failures: this.failures,
        sinceConfirmedMs: now - this.lastConfirmed,
      }),
    );
  }

  private async tick() {
    if (this.stopped) return;
    if (this.pending) {
      if (Date.now() - this.lastConfirmed >= 30_000) this.warn("write_pending");
      return;
    }
    this.pending = true;
    try {
      const alive = await this.renew();
      if (this.stopped) return;
      if (!alive) {
        console.warn(JSON.stringify({ event: "turn.lease_lost", turnId: this.turnId }));
        this.stop();
        this.lost();
        return;
      }
      if (this.lastWarning !== undefined) {
        console.info(
          JSON.stringify({
            event: "turn.heartbeat_recovered",
            turnId: this.turnId,
            failures: this.failures,
            sinceConfirmedMs: Date.now() - this.lastConfirmed,
          }),
        );
      }
      this.lastConfirmed = Date.now();
      this.lastWarning = undefined;
      this.failures = 0;
    } catch {
      if (this.stopped) return;
      this.failures += 1;
      this.warn("write_failed");
    } finally {
      this.pending = false;
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }
}
