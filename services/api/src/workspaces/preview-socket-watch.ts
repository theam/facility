/** How long an open preview WebSocket may outlive the access that opened it. */
export const PREVIEW_REVALIDATE_MS = 30_000;

/** Application close codes: `closeWebSocket` passes 3000–4999 through with the reason. */
export const PREVIEW_SOCKET_REVOKED = 4401;
export const PREVIEW_SOCKET_EXPIRED = 4408;

// setTimeout stores its delay as a signed 32-bit integer.
const MAX_TIMER_MS = 2 ** 31 - 1;

type Close = (code: number, reason: string) => void;

interface WatchedSession {
  token: string;
  expiresAt: number;
  closers: Set<Close>;
  checking: boolean;
  interval: ReturnType<typeof setInterval>;
  expiry: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Keeps open preview WebSockets bound to the session that authorized their
 * upgrade. HTTP requests re-read the session on every request; a socket has no
 * requests, so the same check runs on a clock instead.
 *
 * Every `intervalMs` the session is authorized again, once per session however
 * many sockets it holds, and a refusal closes them all with 4401: proxying stops
 * within one interval of the permission being lost. The session's expiry closes
 * them with 4408 to the second, with no query at all. Cost is bounded by time,
 * never by frame volume. A check that fails for any other reason (a database
 * error) leaves the sockets open until the next one; the expiry still bounds them.
 */
export class PreviewSocketWatch {
  private readonly sessions = new Map<string, WatchedSession>();

  constructor(
    private readonly authorize: (sessionId: string, token: string) => Promise<unknown>,
    private readonly intervalMs = PREVIEW_REVALIDATE_MS,
  ) {}

  /** Watch one socket; the returned function must run when it closes. */
  watch(session: { id: string; expiresAt: Date }, token: string, close: Close) {
    let watched = this.sessions.get(session.id);
    if (!watched) {
      const sessionId = session.id;
      const interval = setInterval(() => void this.check(sessionId), this.intervalMs);
      interval.unref?.();
      watched = {
        token,
        expiresAt: session.expiresAt.getTime(),
        closers: new Set(),
        checking: false,
        interval,
        expiry: undefined,
      };
      this.sessions.set(sessionId, watched);
      this.scheduleExpiry(sessionId, watched);
    }
    watched.closers.add(close);
    const current = watched;
    return () => {
      current.closers.delete(close);
      if (current.closers.size === 0 && this.sessions.get(session.id) === current)
        this.forget(session.id, current);
    };
  }

  /** Sessions with at least one open socket. */
  get size() {
    return this.sessions.size;
  }

  private scheduleExpiry(sessionId: string, watched: WatchedSession) {
    const remaining = watched.expiresAt - Date.now();
    if (remaining <= 0) {
      queueMicrotask(() => this.closeAll(sessionId, PREVIEW_SOCKET_EXPIRED));
      return;
    }
    watched.expiry = setTimeout(
      () => this.scheduleExpiry(sessionId, watched),
      Math.min(remaining, MAX_TIMER_MS),
    );
    watched.expiry.unref?.();
  }

  private async check(sessionId: string) {
    const watched = this.sessions.get(sessionId);
    if (!watched || watched.checking) return;
    watched.checking = true;
    try {
      await this.authorize(sessionId, watched.token);
    } catch (error) {
      if ((error as { code?: unknown }).code === "preview_access_invalid")
        this.closeAll(
          sessionId,
          Date.now() >= watched.expiresAt ? PREVIEW_SOCKET_EXPIRED : PREVIEW_SOCKET_REVOKED,
        );
    } finally {
      watched.checking = false;
    }
  }

  private closeAll(sessionId: string, code: number) {
    const watched = this.sessions.get(sessionId);
    if (!watched) return;
    this.forget(sessionId, watched);
    const reason =
      code === PREVIEW_SOCKET_EXPIRED ? "Preview session expired" : "Preview access revoked";
    for (const close of watched.closers) close(code, reason);
  }

  private forget(sessionId: string, watched: WatchedSession) {
    clearInterval(watched.interval);
    clearTimeout(watched.expiry);
    this.sessions.delete(sessionId);
  }
}
