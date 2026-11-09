/** Executed in the workspace, never in the API process. No environment values are emitted. */
export const ENGINE_PROCESS_CLEANUP = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const turn = process.env.FACILITY_INTERRUPTED_TURN_ID;
if (!/^turn_[A-Za-z0-9_-]+$/.test(turn)) process.exit(64);
const directory = path.join(path.dirname(process.env.HOME), 'engine-processes');
const markers = [path.join(directory, turn + '.pid'), path.join(directory, turn + '.native.pid')];
function marker(file) {
  try { const value = fs.readFileSync(file, 'utf8').trim(); return /^[1-9][0-9]*$/.test(value) ? Number(value) : null; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const markerPids = markers.map(marker);
const hadMarker = markers.some(file => fs.existsSync(file));
if (process.platform !== 'linux') { process.stdout.write(hadMarker ? 'stale-marker' : 'absent'); process.exit(0); }
function record(pid) {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
    let readable = true, owned = false;
    try { owned = fs.readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0').includes('FACILITY_TURN_ID=' + turn); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; readable = false; }
    return { pid, state: fields[0], group: Number(fields[2]), owned, readable };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}
function snapshot() {
  return fs.readdirSync('/proc').filter(value => /^[1-9][0-9]*$/.test(value))
    .map(value => record(Number(value))).filter(value => value && value.pid !== process.pid && value.state !== 'Z');
}
const initial = snapshot();
for (const pid of markerPids.filter(Boolean)) {
  const value = initial.find(item => item.pid === pid);
  if (value && !value.readable) throw new Error('Cannot verify marked process ownership');
}
// The usage monitor starts the native CLI in its own process group. Legacy
// monitor/CLI markers are also handled through exact per-turn environment tags.
const nativeGroup = markerPids[1];
// A reduced-environment orphan may still own the group. A numeric stale
// marker cannot authenticate it; ask the provider to fence this workspace.
const requiresComputeFence = nativeGroup && initial.some(item => item.group === nativeGroup) && !initial.some(item => item.owned && item.group === nativeGroup);
const groups = new Set(nativeGroup && initial.some(item => item.owned && item.group === nativeGroup) ? [nativeGroup] : []);
const targets = () => snapshot().filter(item => item.owned || groups.has(item.group));
const beganActive = targets().length > 0;
function signal(name) {
  const current = targets();
  for (const group of groups) {
    if (!current.some(item => item.group === group && item.owned)) return false;
    try { process.kill(-group, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (const item of current) {
    if (groups.has(item.group)) continue;
    const fresh = record(item.pid);
    if (!fresh?.owned || fresh.state === 'Z') continue;
    try { process.kill(item.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return true;
}
async function waitUntilStopped() {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!targets().length) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !targets().length;
}
async function run() {
  if (requiresComputeFence || !signal('SIGTERM')) { process.stdout.write('compute-fence-required'); return; }
  if (!(await waitUntilStopped())) {
    if (!signal('SIGKILL')) { process.stdout.write('compute-fence-required'); return; }
    if (!(await waitUntilStopped())) throw new Error('Native writer stop is unconfirmed');
  }
  for (const file of markers) { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  process.stdout.write(beganActive ? 'stopped' : hadMarker ? 'stale-marker' : 'absent');
}
run().catch(() => { process.stderr.write('Native writer stop is unconfirmed'); process.exitCode = 1; });
`;
