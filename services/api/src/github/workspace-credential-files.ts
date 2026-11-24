/** Installed by the control plane, including in retained workspaces using an older runner. */
export const credentialHelperSource = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
function fail() { console.error('Facility GitHub credentials unavailable or expired; renewal is required.'); process.exit(1); }
try {
  const file = path.join(__dirname, '..', 'credentials.json');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let value;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 262144 || (stat.mode & 63) !== 0 || stat.uid !== process.getuid()) fail();
    value = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
  if (!Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) fail();
  if (path.basename(process.argv[1]) === 'gh') {
    const args = process.argv.slice(2);
    if (process.env.GH_HOST && process.env.GH_HOST !== 'github.com') fail();
    if (args.some(arg => /^https?:\/\//.test(arg) && !/^https:\/\/(api\.)?github\.com(\/|$)/.test(arg))) fail();
    // Only positional command targets select credentials. Option values are data,
    // even when a body/title happens to contain a GitHub URL or look like -R.
    const kind = args[0], action = args[1];
    const urlActions = kind === 'pr'
      ? ['checkout', 'checks', 'close', 'comment', 'diff', 'edit', 'lock', 'merge', 'ready', 'reopen', 'review', 'unlock', 'view']
      : kind === 'issue' ? ['close', 'comment', 'delete', 'develop', 'edit', 'lock', 'pin', 'reopen', 'transfer', 'unlock', 'unpin', 'view'] : [];
    const switches = kind === 'api' ? ['--paginate', '--slurp', '--silent', '--include', '-i', '--verbose']
      : ({ create: ['--draft', '-d', '--fill', '-f', '--fill-first', '--fill-verbose', '--web', '-w', '--editor', '-e', '--dry-run'],
          list: kind === 'pr' ? ['--draft', '-d', '--web', '-w'] : kind === 'run' ? ['--all', '-a'] : ['--web', '-w'],
          view: ['--web', '-w', '--comments', '-c'], diff: ['--web', '-w', '--patch', '--stat', '--name-only'],
          checks: ['--watch', '--fail-fast', '--required', '--web', '-w'], checkout: ['--detach', '--force', '-f', '--recurse-submodules'],
          merge: ['--auto', '--disable-auto', '--admin', '--delete-branch', '-d', '--merge', '-m', '--squash', '-s', '--rebase', '-r'],
          edit: ['--remove-milestone'],
          review: ['--approve', '-a', '--request-changes', '-r', '--comment', '-c'], ready: ['--undo'],
          comment: ['--edit-last', '--create-if-none', '--delete-last', '--yes'], close: ['--delete-branch', '-d'],
          delete: ['--yes'], develop: ['--checkout', '-c', '--list', '-l'] })[action] || [];
    const normalize = input => String(input).replace(/^https:\/\/github\.com\//, '').replace(/^github\.com\//, '').replace(/\.git$/, '').toLowerCase();
    const valueFlags = ['--body', '-b', '--body-file', '-F', '--title', '-t', '--json', '--jq', '-q', '--template',
      '--author', '-A', '--assignee', '-a', '--label', '-l', '--base', '-B', '--head', '-H', '--reviewer', '-r',
      '--project', '-p', '--milestone', '-m', '--state', '-s', '--limit', '-L', '--search', '-S', '--sort', '--order',
      '--reason', '--branch', '--match-head-commit', '--subject', '--recover', '--interval', '-i',
      '--add-label', '--remove-label', '--add-assignee', '--remove-assignee', '--add-reviewer', '--remove-reviewer',
      '--add-project', '--remove-project', '--method', '-X', '--field', '-f', '--raw-field', '--input', '--header', '--cache'];
    let explicit, target, ambiguous = false;
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') { positional.push(...args.slice(i + 1)); break; }
      if (arg === '--hostname') { if (args[++i] !== 'github.com') fail(); }
      else if (arg.startsWith('--hostname=')) { if (arg !== '--hostname=github.com') fail(); }
      else if (arg === '-R' || arg === '--repo') explicit = normalize(args[++i]);
      else if (arg.startsWith('--repo=')) explicit = normalize(arg.slice(7));
      else if (arg.startsWith('-R') && arg.length > 2) explicit = normalize(arg.slice(2));
      else if (arg.startsWith('-')) {
        if (switches.includes(arg) || ['--help', '-h', '--version'].includes(arg)) continue;
        if (valueFlags.includes(arg)) { i++; continue; }
        if (arg.startsWith('--') && arg.includes('=')) continue;
        if (!arg.startsWith('--') && arg.length > 2) {
          if (valueFlags.includes(arg.slice(0, 2)) && !switches.includes(arg.slice(0, 2))) continue;
          if ([...arg.slice(1)].every(flag => switches.includes('-' + flag))) continue;
        }
        ambiguous = true; break;
      } else if (i >= (kind === 'api' ? 1 : 2)) positional.push(arg);
    }
    if (ambiguous && !process.env.GH_REPO) {
      console.error('Facility cannot safely infer the repository for these gh options. Set GH_REPO=owner/repo explicitly.');
      process.exit(1);
    }
    const first = String(positional[0]);
    const match = kind === 'api'
      ? first.match(/^(?:https:\/\/api\.github\.com\/|\/)?repos\/([a-z0-9_.-]+\/[a-z0-9_.-]+)(?:\/|$)/i)
      : urlActions.includes(action) && first.match(/^https:\/\/github\.com\/([a-z0-9_.-]+\/[a-z0-9_.-]+)(?:\/|$)/i);
    if (!ambiguous && match) target = normalize(match[1]);
    if (explicit && target && explicit !== target) fail();
    let repo = ambiguous ? normalize(process.env.GH_REPO) : target || explicit || (process.env.GH_REPO && normalize(process.env.GH_REPO));
    if (!repo) {
      const options = { encoding: 'utf8', timeout: 2000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'ignore'] };
      const remote = cp.spawnSync('git', ['remote', 'get-url', 'origin'], options);
      if (remote.status === 0) {
        const origin = remote.stdout.trim().replace(/^git@github\.com:/, '').replace(/^ssh:\/\/git@github\.com\//, '');
        repo = normalize(origin);
      } else {
        if (cp.spawnSync('git', ['rev-parse', '--is-inside-work-tree'], options).status === 0) fail();
        repo = value.primary;
      }
    }
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo) || typeof value.tokens[repo] !== 'string') fail();
    if (typeof value.gh !== 'string' || !path.isAbsolute(value.gh) || path.resolve(value.gh) === path.resolve(process.argv[1])) fail();
    const result = cp.spawnSync(value.gh, args, { stdio: 'inherit', env: { ...process.env, GH_REPO: process.env.GH_REPO || repo, GH_TOKEN: value.tokens[repo], GITHUB_TOKEN: value.tokens[repo] } });
    process.exit(result.status === null ? 1 : result.status);
  }
  if (process.argv[2] !== 'get') process.exit(0);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; if (input.length > 8192) fail(); });
  process.stdin.on('end', () => {
    try {
      const fields = Object.fromEntries(input.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
      if (fields.protocol !== 'https' || fields.host !== 'github.com') process.exit(0);
      const repo = String(fields.path || '').replace(/\.git$/, '').toLowerCase();
      if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)) process.exit(0);
      const token = value.tokens[repo];
      if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) process.exit(0);
      process.stdout.write('username=x-access-token\npassword=' + token + '\n\n');
    } catch { fail(); }
  });
} catch { fail(); }
`;

/** Payload travels only in the provider environment, never in argv, events or stdout. */
export const installCredentialFilesSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve('.facility/github', process.env.FACILITY_CREDENTIAL_TURN);
const bin = path.join(root, 'bin');
const payload = JSON.parse(process.env.FACILITY_CREDENTIAL_PAYLOAD);
const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
fs.mkdirSync(bin, { recursive: true, mode: 448 });
for (const dir of [path.dirname(root), root, bin]) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('invalid credential directory');
  fs.chmodSync(dir, 448);
}
const originalPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
const gh = originalPath.split(path.delimiter).map(dir => path.join(dir, 'gh')).find(file => {
  try { return !file.startsWith(root + path.sep) && fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true); } catch { return false; }
});
if (!gh) throw Error('GitHub CLI is unavailable');
for (const name of ['gh', 'facility-git-credential']) {
  const file = path.join(bin, name);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 448);
  try { fs.writeFileSync(fd, process.env.FACILITY_CREDENTIAL_HELPER); fs.fchmodSync(fd, 448); } finally { fs.closeSync(fd); }
}
fs.mkdirSync(path.join(root, 'gh'), { recursive: true, mode: 448 });
const ghDirectory = fs.lstatSync(path.join(root, 'gh'));
if (!ghDirectory.isDirectory() || ghDirectory.isSymbolicLink() || ghDirectory.uid !== process.getuid()) throw Error('invalid gh configuration directory');
fs.chmodSync(path.join(root, 'gh'), 448);
const hostFile = path.join(root, 'gh', 'hosts.yml');
const hostTemp = hostFile + '.' + require('node:crypto').randomUUID();
try {
  fs.writeFileSync(hostTemp, JSON.stringify({ 'github.com': { oauth_token: payload.tokens[payload.primary], git_protocol: 'https', user: payload.user, users: { [payload.user]: { oauth_token: payload.tokens[payload.primary] } } } }), { mode: 384, flag: 'wx' });
  fs.renameSync(hostTemp, hostFile);
} finally { fs.rmSync(hostTemp, { force: true }); }
const target = path.join(root, 'credentials.json');
const temp = target + '.' + require('node:crypto').randomUUID();
try {
  fs.writeFileSync(temp, JSON.stringify({ ...payload, gh }), { mode: 384, flag: 'wx' });
  fs.renameSync(temp, target);
} finally { fs.rmSync(temp, { force: true }); }
console.log(JSON.stringify({ root, bin, helper: '!' + quote(process.execPath) + ' ' + quote(path.join(bin, 'facility-git-credential')), originalPath }));
`;

export const updateCredentialFilesSource = `
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.FACILITY_CREDENTIAL_ROOT;
const file = path.join(root, 'credentials.json');
const old = JSON.parse(fs.readFileSync(file, 'utf8'));
const payload = JSON.parse(process.env.FACILITY_CREDENTIAL_PAYLOAD);
const temp = file + '.' + require('node:crypto').randomUUID();
try {
  fs.writeFileSync(temp, JSON.stringify({ ...payload, gh: old.gh }), { mode: 384, flag: 'wx' });
  const hostFile = path.join(root, 'gh', 'hosts.yml');
  const hostTemp = hostFile + '.' + require('node:crypto').randomUUID();
  try {
    fs.writeFileSync(hostTemp, JSON.stringify({ 'github.com': { oauth_token: payload.tokens[payload.primary], git_protocol: 'https', user: payload.user, users: { [payload.user]: { oauth_token: payload.tokens[payload.primary] } } } }), { mode: 384, flag: 'wx' });
    fs.renameSync(hostTemp, hostFile);
  } finally { fs.rmSync(hostTemp, { force: true }); }
  fs.renameSync(temp, file);
} finally { fs.rmSync(temp, { force: true }); }
`;

export const removeCredentialFilesSource = `
const fs = require('node:fs');
const path = require('node:path');
for (const file of ['credentials.json', 'gh/hosts.yml', 'gh/hosts.yml.new']) fs.rmSync(path.join(process.env.FACILITY_CREDENTIAL_ROOT, file), { force: true });
`;
