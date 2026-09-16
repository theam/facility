import { z } from "zod";

const counter = z.number().finite().nonnegative();
export const WorkspaceHealthSchema = z.object({
  memoryTotalBytes: counter.optional(),
  memoryAvailableBytes: counter.optional(),
  memoryCurrentBytes: counter.optional(),
  memoryLimitBytes: counter.optional(),
  oomKills: counter.optional(),
  load1: counter.optional(),
  diskAvailableBytes: counter.optional(),
  diskTotalBytes: counter.optional(),
  uptimeSeconds: counter.optional(),
  bootId: z.string().uuid().optional(),
  gitHead: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  changedFiles: counter.int().optional(),
});

export type WorkspaceDiagnostics = {
  provider: string;
  state: string;
  computeRef?: string;
  health?: z.infer<typeof WorkspaceHealthSchema>;
  probe?: "ok" | "unavailable";
};

export function parseWorkspaceHealth(stdout: string) {
  if (Buffer.byteLength(stdout) > 8_192) throw new Error("Workspace health response too large");
  return WorkspaceHealthSchema.parse(JSON.parse(stdout));
}

// Only numeric resource counters and opaque recovery identifiers leave the VM.
// Never collect environment variables, process arguments, file contents or network URLs.
export const WORKSPACE_HEALTH_COMMAND = String.raw`
const fs = require('node:fs');
const cp = require('node:child_process');
const result = {};
const read = path => { try { return fs.readFileSync(path, 'utf8').trim(); } catch { return ''; } };
const number = (key, value, factor = 1) => {
  if (!value || !Number.isFinite(Number(value)) || Number(value) < 0) return;
  result[key] = Number(value) * factor;
};
const mem = read('/proc/meminfo');
number('memoryTotalBytes', mem.match(/^MemTotal:\s+(\d+)/m)?.[1], 1024);
number('memoryAvailableBytes', mem.match(/^MemAvailable:\s+(\d+)/m)?.[1], 1024);
number('memoryCurrentBytes', read('/sys/fs/cgroup/memory.current'));
number('memoryLimitBytes', read('/sys/fs/cgroup/memory.max'));
number('oomKills', read('/sys/fs/cgroup/memory.events').match(/^oom_kill\s+(\d+)/m)?.[1]);
number('load1', read('/proc/loadavg').split(' ')[0]);
number('uptimeSeconds', read('/proc/uptime').split(' ')[0]);
const boot = read('/proc/sys/kernel/random/boot_id');
if (/^[a-f0-9-]{36}$/.test(boot)) result.bootId = boot;
try {
  const disk = fs.statfsSync('/workspace');
  result.diskAvailableBytes = disk.bavail * disk.bsize;
  result.diskTotalBytes = disk.blocks * disk.bsize;
} catch {}
const cwd = process.argv[1];
const git = args => cp.execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', timeout: 1500, maxBuffer: 262144, stdio: ['ignore', 'pipe', 'ignore'],
  env: {...process.env, GIT_OPTIONAL_LOCKS: '0'},
}).trim();
try { result.gitHead = git(['rev-parse', 'HEAD']); } catch {}
try { result.changedFiles = git(['status', '--porcelain', '-uno']).split('\n').filter(Boolean).length; } catch {}
console.log(JSON.stringify(result));
`;
