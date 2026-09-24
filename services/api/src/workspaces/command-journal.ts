import { StringDecoder } from "node:string_decoder";
import type { WorkspaceCommandOutput } from "./runtime.js";

export const COMMAND_JOURNAL_SEGMENT_BYTES = 256 * 1024;

/** Sequence numbers survive provider replay, truncation, and UTF-8 chunk changes. */
export class CommandJournal {
  private next = 0;
  private pending = "";
  result?: { exitCode: number; durationMs: number };

  get nextSequence() {
    return this.next;
  }
  private readonly decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };

  constructor(private readonly output: (event: WorkspaceCommandOutput) => void) {}

  restart() {
    this.pending = "";
  }

  push(data: string) {
    this.pending += data;
    let newline = this.pending.indexOf("\n");
    while (newline !== -1) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      const frame = parseFrame(line);
      if (frame.seq > this.next) throw new Error("Command journal has a gap");
      if (frame.seq === this.next) {
        if (this.result) throw new Error("Command journal continued after exit");
        this.next += 1;
        if ("exitCode" in frame) {
          this.result = { exitCode: frame.exitCode, durationMs: frame.durationMs };
        } else {
          const stream = frame.stream as "stdout" | "stderr";
          const data = this.decoders[stream].write(Buffer.from(frame.data, "base64"));
          if (data) this.output({ stream, data });
        }
      }
      newline = this.pending.indexOf("\n");
    }
  }

  finish() {
    if (this.pending) throw new Error("Command journal ended with an incomplete frame");
    for (const stream of ["stdout", "stderr"] as const) {
      const data = this.decoders[stream].end();
      if (data) this.output({ stream, data });
    }
  }
}

type JournalFrame =
  | { seq: number; stream: "stdout" | "stderr"; data: string }
  | { seq: number; type: "exit"; exitCode: number; durationMs: number };

function parseFrame(line: string): JournalFrame {
  const frame = JSON.parse(line);
  if (!frame || !Number.isSafeInteger(frame.seq) || frame.seq < 0) {
    throw new Error("Invalid command journal sequence");
  }
  if (frame.type === "exit") {
    if (
      !Number.isInteger(frame.exitCode) ||
      frame.exitCode < 0 ||
      frame.exitCode > 255 ||
      !Number.isSafeInteger(frame.durationMs) ||
      frame.durationMs < 0
    ) {
      throw new Error("Invalid command journal exit event");
    }
  } else if (
    frame.type !== undefined ||
    !["stdout", "stderr"].includes(frame.stream) ||
    typeof frame.data !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)
  ) {
    throw new Error("Invalid command journal frame");
  }
  return frame;
}

// The private journal lives on the durable volume. Only encoded frames cross the
// provider's log stream; native bytes are decoded exactly once by the observer.
export const COMMAND_JOURNAL_WRAPPER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const [journal, command, ...args] = process.argv.slice(1);
fs.mkdirSync(path.dirname(journal), { recursive: true, mode: 0o700 });
let segment = 0;
let written = 0;
let fd = fs.openSync(journal + '.0', 'wx', 0o600);
let seq = 0;
const startedAt = Date.now();
function publish(event) {
  const frame = JSON.stringify({ seq: seq++, ...event }) + '\n';
  if (written >= ${COMMAND_JOURNAL_SEGMENT_BYTES}) {
    fs.closeSync(fd);
    fd = fs.openSync(journal + '.' + (++segment), 'wx', 0o600);
    written = 0;
  }
  written += fs.writeSync(fd, frame);
  process.stdout.write(frame);
}
function write(stream, data) {
  publish({ stream, data: Buffer.from(data).toString('base64') });
}
const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
child.stdout.on('data', data => write('stdout', data));
child.stderr.on('data', data => write('stderr', data));
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {
  try { process.kill(-child.pid, signal); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref();
});
child.on('error', () => { write('stderr', 'Command could not be started\n'); });
child.on('close', code => {
  const exitCode = code ?? 1;
  publish({ type: 'exit', exitCode, durationMs: Date.now() - startedAt });
  fs.closeSync(fd);
  process.exitCode = exitCode;
});
`;
