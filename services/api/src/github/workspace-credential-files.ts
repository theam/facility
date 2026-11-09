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
    let repo = process.env.GH_REPO || value.primary;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--hostname' && args[i + 1] !== 'github.com') fail();
      if (args[i].startsWith('--hostname=') && args[i] !== '--hostname=github.com') fail();
      if (args[i] === '-R' || args[i] === '--repo') repo = args[++i];
      else if (args[i].startsWith('--repo=')) repo = args[i].slice(7);
    }
    repo = String(repo).replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').toLowerCase();
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo) || typeof value.tokens[repo] !== 'string') fail();
    if (typeof value.gh !== 'string' || !path.isAbsolute(value.gh) || path.resolve(value.gh) === path.resolve(process.argv[1])) fail();
    const result = cp.spawnSync(value.gh, args, { stdio: 'inherit', env: { ...process.env, GH_TOKEN: value.tokens[repo], GITHUB_TOKEN: value.tokens[repo] } });
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
