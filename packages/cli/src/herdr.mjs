import { spawn } from "node:child_process";

export class HerdrReporter {
  constructor(env = process.env, launch = spawn) {
    this.env = env;
    this.launch = launch;
    this.seq = Date.now() * 1000;
    this.chain = Promise.resolve();
    this.pendingState = null;
    this.reporting = false;
  }
  enabled() { return this.env.HERDR_ENV === "1" && this.env.HERDR_BIN_PATH && this.env.HERDR_PANE_ID && this.env.HERDR_SOCKET_PATH; }
  async report(command, args) {
    if (!this.enabled()) return;
    const argv = ["pane", command, this.env.HERDR_PANE_ID, "--source", "facility", "--agent", "Facility", "--seq", String(++this.seq), ...args];
    await new Promise((resolve) => {
      try {
        const child = this.launch(this.env.HERDR_BIN_PATH, argv, { stdio: "ignore", env: this.env });
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1500);
        timer.unref();
        const done = () => { clearTimeout(timer); resolve(); };
        child.once("error", done); child.once("exit", done);
      } catch { resolve(); }
    });
  }
  attach(title, engine, resume) {
    this.chain = this.chain.then(async () => {
      await this.report("report-agent", ["--state", "idle", "--", "facility", "attach", resume]);
      await this.report("report-metadata", ["--title", title.slice(0, 200), "--display-agent", `Facility · ${engine === "codex" ? "Codex" : "Claude Code"}`]);
    });
  }
  state(state, message, label) {
    this.pendingState = { state, message, label };
    if (this.reporting) return;
    this.reporting = true;
    this.chain = this.chain.then(async () => {
      while (this.pendingState) {
        const next = this.pendingState; this.pendingState = null;
        await this.report("report-agent", ["--state", next.state, ...(next.message ? ["--message", next.message.slice(0, 1000)] : [])]);
        await this.report("report-metadata", next.label ? ["--state-label", `idle=${next.label}`] : ["--clear-state-labels"]);
      }
      this.reporting = false;
    });
  }
  async release() { await this.chain; await this.report("release-agent", []); }
}
