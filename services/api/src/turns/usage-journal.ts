import type { WorkspaceLocator, WorkspaceRuntime } from "../workspaces/runtime.js";
import type { AgentTurnUsage } from "./engines.js";

/** Runs inside the durable workspace, independently of the observing worker.
 * Persist only counters: transcripts, prompts and credentials never enter this journal.
 */
export const ENGINE_USAGE_PROCESS = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const turnId = process.env.FACILITY_TURN_ID;
const engine = process.env.FACILITY_ENGINE;
if (!/^turn_[A-Za-z0-9_-]+$/.test(turnId) || !['codex', 'claude_code'].includes(engine)) process.exit(64);
const dir = path.join(path.dirname(process.env.HOME), 'engine-usage');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, turnId + '.json');
let usage;
let complete = false;
let invalid = false;
let buffer = '';
const messages = new Map();
const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const integer = n => Number.isSafeInteger(n) && n >= 0;
function counters(value) {
  if (!value || typeof value !== 'object') return;
  const values = [value.input_tokens, value.output_tokens,
    value.cache_read_input_tokens ?? value.cached_input_tokens ?? 0,
    value.cache_creation_input_tokens ?? 0];
  if (!values.every(integer)) return;
  return Object.fromEntries(keys.map((key, i) => [key, values[i]]));
}
function save() {
  fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, turnId, engine, complete: complete && !invalid, usage }), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function accept(line) {
  if (!line.trim()) return;
  let event;
  try { event = JSON.parse(line); } catch { invalid = true; save(); return; }
  if (!event || typeof event !== 'object' || Array.isArray(event)) { invalid = true; save(); return; }
  if (engine === 'claude_code' && event.type === 'assistant') {
    const message = event.message;
    const measured = counters(message?.usage);
    if (measured && typeof message.id === 'string' && message.id.length <= 200) {
      messages.set(message.id, measured);
      usage = Object.fromEntries(keys.map(key => [key, [...messages.values()].reduce((sum, item) => sum + item[key], 0)]));
      save();
    }
  }
  if ((engine === 'claude_code' && event.type === 'result') || (engine === 'codex' && event.type === 'turn.completed')) {
    const measured = counters(event.usage);
    if (measured) {
      usage = measured;
      if (engine === 'claude_code' && Number.isFinite(event.total_cost_usd) && event.total_cost_usd >= 0)
        usage.reportedCostCents = event.total_cost_usd * 100;
      complete = true;
    } else invalid = true;
    save();
  }
}
save();
const child = spawn(process.argv[1], process.argv.slice(2), { stdio: ['inherit', 'pipe', 'inherit'] });
// A dead observer closes stdout. Keep draining the CLI and journaling its usage.
process.stdout.on('error', () => {});
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  // Journal first; losing the API worker must not lose the provider's final usage.
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) { accept(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
  if (buffer.length > 4 * 1024 * 1024) { invalid = true; buffer = ''; save(); }
  process.stdout.write(chunk);
});
child.on('error', () => { invalid = true; save(); process.exitCode = 127; });
child.on('close', code => { if (buffer) accept(buffer); save(); process.exitCode = code ?? 1; });
`;

export type RecoveredUsage = { usage?: AgentTurnUsage; complete: boolean };

export function parseUsageJournal(raw: string, turnId: string, engine: string): RecoveredUsage {
  const unknown = { complete: false };
  if (raw.length > 4096) return unknown;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw);
  } catch {
    return unknown;
  }
  if (value?.version !== 1 || value.turnId !== turnId || value.engine !== engine) return unknown;
  const usage = value.usage as AgentTurnUsage | undefined;
  if (
    !usage ||
    [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].some(
      (n) => !Number.isSafeInteger(n) || n < 0,
    )
  )
    return unknown;
  if (
    usage.reportedCostCents !== undefined &&
    (!Number.isFinite(usage.reportedCostCents) || usage.reportedCostCents < 0)
  )
    return unknown;
  return { usage, complete: value.complete === true };
}

export async function readUsageJournal(
  runtime: WorkspaceRuntime,
  workspace: WorkspaceLocator,
  turnId: string,
  engine: string,
): Promise<RecoveredUsage> {
  if (!/^turn_[A-Za-z0-9_-]+$/.test(turnId)) return { complete: false };
  try {
    const result = await runtime.exec(workspace, {
      resume: false,
      command: "node",
      args: [
        "-e",
        "const fs=require('node:fs'),path=require('node:path');const file=path.join(path.dirname(process.env.HOME),'engine-usage',process.argv[1]+'.json');const fd=fs.openSync(file,'r');const buf=Buffer.alloc(4097);const size=fs.readSync(fd,buf,0,buf.length,0);fs.closeSync(fd);process.stdout.write(buf.subarray(0,size));",
        turnId,
      ],
      timeoutMs: 15_000,
    });
    return result.exitCode === 0
      ? parseUsageJournal(result.stdout, turnId, engine)
      : { complete: false };
  } catch {
    return { complete: false };
  }
}
