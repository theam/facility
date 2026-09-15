# Native Vercel previews with Facility login

The opt-in native path uses the HTTPS origin already assigned to a Vercel Sandbox
gateway port. It needs no new CloudFront distribution, reverse-proxy hostname or
per-story site configuration. The gateway in that same workspace protects browser
access; the project's Compose stack remains responsible for the application.

## Project opt-in

Native preview URLs are **off by default for every project**, including existing
projects. In **Project → Settings → native preview URLs**, a user with
`projects:write` can enable or disable that project. Saving does not start, rebuild
or upgrade a workspace, change roles, or modify another project's configuration.
The URL is externally reachable; the application behind it still requires Facility
login and the preview permissions described below. This is not anonymous access.

There are two independent controls:

- `FACILITY_NATIVE_PREVIEWS=1` on API and worker makes the capability available on a
  compatible Vercel installation. By itself, it opts in **no projects**.
- `projects.settings.nativePreviewsEnabled === true` opts in one project. Missing
  settings and every value other than the boolean `true` are treated as disabled.

The UI distinguishes a saved preference from installation availability. You may
save the preference before an operator enables the installation capability, but
native access remains disabled until both controls are on. Ordinary projects
continue using their legacy preview flow and do not run native capability checks.

Automation can use the existing `PATCH /v1/projects/:projectId` endpoint with
`{ "nativePreviewsEnabled": true }` and an idempotency key. This narrowly merges the
preference without replacing unrelated settings. Do not send `settings` and
`nativePreviewsEnabled` together. The existing generic `settings` update retains
its replacement semantics and validates the reserved field as a boolean.
Project responses expose `nativePreviews: { enabled, available }`; effective opt-in
requires both. Existing authorization, tenant/project restrictions and audit apply.

Disabling a project rejects subsequent native logins, grant exchanges, HTTP
authorization and WebSocket handshakes, even with retained endpoint metadata or
previously-issued sessions. Already-established connections are not terminated.
The next operator wake/open reconfigures the gateway for the legacy path. No
workspace, application data or existing preview-site configuration is deleted.

## Access and browser flow

1. A visitor opens the provider URL. The gateway sends them to Facility's web
   origin, carrying a challenge tied to a temporary HttpOnly browser cookie.
   This signed, two-minute cookie also retains the same-origin application path
   and query; those values are not sent to Facility or the identity provider.
2. Facility uses its normal login and checks the active user's membership and
   `previews:read` or `workspaces:execute` permission. It discovers the destination
   from its persisted, verified workspace endpoint, never from a caller's return URL.
3. Facility returns a random one-time code to that gateway. The gateway exchanges
   it server-to-server using its existing workspace credential and the browser
   verifier. The code expires after 60 seconds and concurrent/replayed exchanges fail.
4. Exchange replaces the code with a different random session credential, stored
   hashed in Facility PostgreSQL and in a host-only `__Host-facility-preview`
   Secure/HttpOnly/SameSite=Lax cookie. Its lifetime is at most one hour.
   The gateway restores the original application path/query, including application
   OAuth callbacks interrupted by preview reauthentication. Only relative,
   non-reserved paths up to 2,048 characters are retained; invalid destinations
   fall back to `/`. Tampered or expired login cookies fail closed.
5. Each HTTP request and WebSocket handshake rechecks the project opt-in, session, current role,
   active membership, workspace state and exact workspace/service/origin binding.
   Unavailable authorization fails closed. An already-established WebSocket is not
   continuously reauthorized; reconnects repeat authorization.

The per-resource `/authorize` route has its own bounded 6,000 requests/minute/IP
budget, independent of the general production API limit of 200/minute/IP. This
initial ceiling allows asset-heavy page loads and concurrent testers behind the
same gateway egress. It also bounds invalid requests; all accepted requests still
need valid gateway and browser credentials and fresh permission checks. It does
not trust forwarded client IPs or caller-chosen session IDs as rate-limit keys.
Visitors sharing an egress still share that budget; tune it from pilot traffic
if needed, rather than disabling rate limiting or caching authorization decisions.

The same view permission covers every accessible preview; there is no per-story
allowlist. Per-workspace browser credentials prevent accidental credential reuse
across hosts, not access to another preview for an otherwise authorized user.
This uses Facility's existing authorization model: human roles are organization-
scoped, and an explicit project restriction is honored if the principal has one.
It does **not** introduce project-level human memberships. Navigating the Facility
project UI additionally needs its normal read permissions.

`previews:read` does not authorize commands. A preview-only Open action returns an
already-prepared, running native URL without waking compute, issuing repository
credentials, running setup/start, or starting an agent. An operator with
`workspaces:execute` can prepare/wake it using the existing Open action. Direct
visits cannot wake sleeping compute; the gateway itself is asleep.

## Application boundary

The gateway forwards root paths, payload bytes, application Authorization headers,
cookies and WebSockets. It strips Facility access credentials and normalizes
forwarded host/protocol to the canonical HTTPS origin. App cookie Domain attributes
are removed; apps cannot overwrite reserved Facility cookies through Set-Cookie.
`/.facility/*` is reserved for the gateway and never forwarded to the application.
The global Facility login cookie stays on the control-plane host. App login, such
as Auth0, remains a separate step with its own callback configuration.

Only exact single-label `https://<sandbox-route>.vercel.run` origins are accepted.
`vercel.run` is a public suffix, so separate route hosts are separate browser sites.
URLs are obtained from the provider SDK and published only after a credentialed
gateway capability/origin check. Ordinary inspection does not advertise compatibility.

This is a visitor-access boundary, **not a security boundary against a malicious
agent controlling the VM**. The workspace has Docker/host capabilities and could
replace its gateway. Strong isolation from hostile workspace code requires an
independently operated edge proxy; do not advertise this mode as providing that.

## Deployment and compatibility

- Keep `FACILITY_NATIVE_PREVIEWS=0` until both API/worker and runner support this
  protocol. Apply migration `v0.12/0008_native_preview_sessions.sql` before the API.
- Publish the matching runner image, then enable the capability with `FACILITY_NATIVE_PREVIEWS=1`
  on **both API and worker**, with `FACILITY_WORKSPACE_DRIVER=vercel`. `PUBLIC_URL`
  and `WEB_URL` must be HTTPS origins without paths or trailing slashes and outside
  `vercel.run`; the web `/api` proxy and existing Facility login must work.
- Opt in only the pilot project from its Settings page. Other projects remain off;
  turning on the installation flag alone never migrates their gateways or URLs.
- Existing legacy preview configuration, including production's
  `FACILITY_PREVIEW_URL` requirement, is unchanged. Native access does not traverse
  that proxy. Docker and deployments with the flag off keep their existing flow.
- Start with a new disposable story. Existing persistent workspaces retain their
  image: changing the image setting does not upgrade that disk. An old gateway
  fails the capability check rather than silently publishing an unprotected app.
  Any migration of an existing workspace must preserve its data explicitly; this
  feature neither deletes it nor reseeds it.
- The bootstrap sets public `FACILITY_NATIVE_PREVIEW` binding metadata and the
  existing private gateway token only on the gateway process. Do not put Facility
  browser sessions or Auth0 management credentials into the agent environment.
- Disable query-string access logging at provider/edge layers: the callback carries
  a short-lived code. The gateway logs no requests and consumes the callback itself;
  Facility's request logger already omits queries and headers.
- For a project rollback, turn off its preference in Settings. For an installation-wide
  rollback, disable the flag on both API and worker. Existing native sessions
  fail authorization. An execute-authorized wake/open reconfigures the gateway for
  the legacy path; retained files and databases are not reset.

## Lifecycle facts and external callbacks

While both controls are on, the existing story GET reports verified native origins in `lifecycle.workspace.sites`
as `{ id: "native-<service>", service, origin }`. Native endpoints take precedence
over a configured legacy site for the same service. No gateway credentials or raw
endpoint metadata are exposed in that snapshot. Suspended workspaces retain their
last recorded origin; permanently destroyed ones do not advertise a native site.
Disabling either control removes native facts and restores configured legacy sites
in the lifecycle snapshot. The worker observes this as a workspace revision change.
External integrations still own callback cleanup policy; this setting does not
delete an Auth0 callback directly.

The existing `facility.workspace.updated` dispatch reflects origin/state changes.
Project-owned integrations can read those facts and reconcile Auth0 or other
callbacks using the same script and per-story integration state. Facility performs
no Auth0 write and defines no project-specific cleanup policy.

**Native URL stability across real Vercel suspend/resume is not established by
these changes.** The SDK supplies the current route; if it changes on resume, the
new endpoint replaces the old fact and old sessions are refused. Consumers must
reconcile callback changes. Do not promise a permanently stable URL until the live
pilot validates it; a stable alias may still be necessary.

## Validation

Default tests use a disposable PostgreSQL database, a fake Vercel SDK, the real
gateway process and local HTTP/WebSocket servers. They cover browser redirects,
code rotation/replay, wrong browser/service/workspace/tenant, role removal, user
disablement, expiry, unavailable authorization, application payload/cookie handling,
native capability checks, lifecycle notifications and preview-only UI actions.
Project opt-in tests cover default-off behavior, unrelated-settings preservation,
scoped and cross-tenant API permissions, strict boolean validation, idempotent saves,
opt-out with existing sessions, lifecycle removal and the legacy runtime path.
The browser suite traverses the real Facility login/callback handlers with a fake
GitHub identity provider, verifies deep-link/application OAuth return URLs and
exercises the actual production limiter (asset bursts and bounded denial traffic).
They require no live GitHub, Auth0 or Vercel credential.

After review and deployment, separately verify a real browser login, application
OAuth, two-story isolation, sleep/resume route identity and persisted product data.
Local tests are not proof of those live acceptance checks.
