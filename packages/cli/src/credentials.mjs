import { mkdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

export const credentialDirectory = () => process.env.FACILITY_CONFIG_DIR ?? join(homedir(), ".config", "facility");
export function instanceUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new Error("Use an HTTPS instance origin, or HTTP on loopback for local development");
  return url.origin;
}
const storePath = () => join(credentialDirectory(), "credentials.json");
export async function readCredentials() {
  try { return JSON.parse(await readFile(storePath(), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { instances: {} }; throw error; }
}
async function atomicJson(value) {
  await mkdir(credentialDirectory(), { recursive: true, mode: 0o700 });
  const temporary = `${storePath()}.${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, storePath());
  } finally { await rm(temporary, { force: true }); }
}

/** Rotate shared refresh tokens under one process lock, including across instances. */
export async function withCredentialLock(action) {
  const directory = credentialDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "credentials.lock");
  const deadline = Date.now() + 45_000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, "owner"), String(process.pid), { mode: 0o600 }); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const pid = Number(await readFile(join(lock, "owner"), "utf8"));
        if (Number.isSafeInteger(pid) && pid > 1) {
          try { process.kill(pid, 0); } catch (cause) { if (cause.code === "ESRCH") { await rm(lock, { recursive: true, force: true }); continue; } }
        }
      } catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
        const info = await stat(lock).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 30_000) { await rm(lock, { recursive: true, force: true }); continue; }
      }
      if (Date.now() >= deadline) throw new Error("Another Facility process is refreshing credentials; try again");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try { return await action(); } finally { await rm(lock, { recursive: true, force: true }); }
}
const keyring = (args, input) => spawnSync("secret-tool", args, { input, encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
export async function saveInstance(url, credentials, storeSecret = keyring) {
  const store = await readCredentials();
  const saved = storeSecret(["store", "--label", "Facility CLI", "application", "facility", "instance", url], JSON.stringify(credentials));
  store.instances[url] = saved.status === 0 ? { storage: "secret-service" } : { storage: "file", credentials };
  store.current = url;
  await atomicJson(store);
}
export async function loadInstance(requested) {
  const store = await readCredentials();
  const url = requested ? instanceUrl(requested) : store.current;
  const entry = store.instances[url];
  if (!entry) throw new Error("Sign in first with facility login <instance-url>");
  const credentials = entry.storage === "secret-service" ? JSON.parse(keyring(["lookup", "application", "facility", "instance", url]).stdout || "null") : entry.credentials;
  if (!credentials) throw new Error("Facility credentials are unavailable; sign in again");
  return { url, ...credentials };
}
export async function accessToken(requested, fetchImpl = fetch, persist = saveInstance) {
  return withCredentialLock(async () => {
    let instance = await loadInstance(requested);
    if (instance.expires_at <= Date.now() + 30_000) {
      if (!instance.refresh_token) throw new Error("Your Facility login expired; run facility login again");
      const response = await fetchImpl(instance.token_endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: instance.refresh_token, client_id: instance.client_id, resource: instance.resource }) });
      if (!response.ok) throw new Error("Facility could not renew your login; run facility login again");
      const tokens = await response.json();
      if (typeof tokens.access_token !== "string" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new Error("Facility returned invalid OAuth tokens");
      instance = { ...instance, ...tokens, expires_at: Date.now() + tokens.expires_in * 1000 };
      const { url, ...values } = instance;
      await persist(url, values);
    }
    return instance;
  });
}
