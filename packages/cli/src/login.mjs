import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { instanceUrl, saveInstance, withCredentialLock } from "./credentials.mjs";

export function validateOAuthEndpoint(value, issuer) {
  const url = new URL(value);
  if (url.origin !== issuer || url.username || url.password || url.hash) throw new Error("OAuth endpoint does not belong to the instance issuer");
  return url.toString();
}
export function startLoopback(expectedState, timeout = 180_000, expectedIssuer) {
  let consumed = false;
  let resolveCode;
  let rejectCode;
  const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  code.catch(() => undefined);
  const server = createServer((request, response) => {
    const target = new URL(request.url, "http://127.0.0.1");
    const received = target.searchParams.get("state") ?? "";
    const validState = Buffer.byteLength(received) === Buffer.byteLength(expectedState) && timingSafeEqual(Buffer.from(received), Buffer.from(expectedState));
    const validIssuer = !expectedIssuer || (target.searchParams.getAll("iss").length === 1 && target.searchParams.get("iss") === expectedIssuer);
    const failure = target.searchParams.get("error");
    if (consumed || request.method !== "GET" || request.headers.host !== `127.0.0.1:${server.address().port}` || target.pathname !== "/callback" || !validState || !validIssuer || target.searchParams.getAll("state").length !== 1 || (failure ? target.searchParams.getAll("error").length !== 1 || target.searchParams.has("code") : target.searchParams.getAll("code").length !== 1)) {
      response.writeHead(400).end("Invalid Facility sign-in callback"); return;
    }
    if (failure) { consumed = true; response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end("Facility sign-in was declined. Return to your terminal."); rejectCode(new Error("Facility browser sign-in was declined; no credentials were saved")); return; }
    const value = target.searchParams.get("code");
    if (!value || value.length > 8192) { response.writeHead(400).end("Invalid authorization code"); return; }
    response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end("Facility sign-in complete. Return to your terminal.");
    consumed = true; resolveCode(value);
  });
  const timer = setTimeout(() => { rejectCode(new Error("Facility browser sign-in timed out")); server.close(); }, timeout);
  timer.unref();
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/callback`));
  });
  return { ready, code, close: () => { clearTimeout(timer); server.closeAllConnections(); server.close(); } };
}
function openBrowser(url) {
  const executable = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const browser = spawn(executable, args, { stdio: "ignore", detached: true });
  browser.on("error", () => undefined); browser.unref();
}
export async function login(value, { fetchImpl = fetch, launchBrowser = openBrowser, persist = saveInstance } = {}) {
  const origin = instanceUrl(value);
  const getJson = async (url, options) => {
    const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(15_000), ...options });
    if (!response.ok) throw new Error(`Facility OAuth request failed (${response.status}); check the instance's OAuth configuration`);
    return response.json();
  };
  const metadata = await getJson(`${origin}/.well-known/oauth-protected-resource/mcp`);
  const issuer = instanceUrl(metadata.authorization_servers?.[0]);
  const discovery = await getJson(`${issuer}/.well-known/openid-configuration`);
  if (discovery.issuer !== issuer && discovery.issuer !== `${issuer}/`) throw new Error("OAuth issuer mismatch");
  const endpoints = Object.fromEntries(["registration_endpoint", "authorization_endpoint", "token_endpoint"].map((name) => [name, validateOAuthEndpoint(discovery[name], issuer)]));
  if (new URL(metadata.resource).origin !== origin) throw new Error("Unexpected Facility OAuth resource");
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const callback = startLoopback(state, 180_000, discovery.issuer);
  try {
    const redirect = await callback.ready;
    const client = await getJson(endpoints.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Facility CLI", application_type: "native", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], redirect_uris: [redirect] }) });
    if (typeof client.client_id !== "string") throw new Error("OAuth registration returned no client identity");
    const authorization = new URL(endpoints.authorization_endpoint);
    authorization.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: "code", scope: "openid offline_access facility:mcp", resource: metadata.resource, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), state, prompt: "consent" }).toString();
    console.log(`Open this URL in a browser on this computer:\n${authorization}`);
    await launchBrowser(authorization.toString());
    const tokens = await getJson(endpoints.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: await callback.code, redirect_uri: redirect, code_verifier: verifier, client_id: client.client_id, resource: metadata.resource }) });
    if (typeof tokens.access_token !== "string" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new Error("Invalid OAuth token response");
    await withCredentialLock(() => persist(origin, { ...tokens, client_id: client.client_id, token_endpoint: endpoints.token_endpoint, issuer, resource: metadata.resource, expires_at: Date.now() + tokens.expires_in * 1000 }));
    console.log(`Signed in to ${origin}`);
    return 0;
  } finally { callback.close(); }
}
