# Stable workspace preview origins

Applications that use OAuth, root routes, cookies or server actions need a stable
origin per workspace and service. The session-specific path proxy remains
available for simple previews. Configure dedicated origins for complete apps.

`FACILITY_PREVIEW_SITES` is a secret JSON array loaded by the API at startup:

```json
[
  {
    "id": "workspace-app",
    "orgId": "org_example",
    "projectId": "proj_example",
    "workspaceId": "ws_example",
    "service": "app",
    "origin": "https://unique-distribution.cloudfront.net",
    "surfaceToken": "REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS"
  }
]
```

Each entry requires a unique origin, credential, and workspace/service binding.
In production, its registered site must differ from all Facility control-plane
origins, the legacy preview origin, and every other configured preview site.
CloudFront's assigned domains provide HTTPS and separate browser sites without
requiring a purchased domain. Different subdomains of a shared registrable domain
are insufficient. Do not configure a user-provided URL or forwarding header as
an authoritative preview origin.

For each service, provision a dedicated reverse proxy (for example, a CloudFront
standard distribution) with:

- The Facility API as its HTTPS origin.
- Origin path `/workspace-preview-site/<id>`.
- An origin header `X-Facility-Preview-Surface` equal to that entry's credential.
  The proxy must overwrite a viewer-supplied header of the same name.
- All seven HTTP methods, all cookies and query strings, and application request
  headers. CloudFront's managed `AllViewerExceptHostHeader` request policy works.
- Disabled caching, including error caching, and WebSocket forwarding.
- Access logging disabled or query-string credentials reliably redacted.

Load the JSON through the deployment's secret store, deploy the API, then enable
the distribution. The Open app action automatically chooses the configured site.
Provisioning is operator-managed; adding an entry does not create cloud resources.
Keep the same distribution and binding when the workspace sleeps or wakes. Disable
and remove its mapping/distribution when the workspace is permanently destroyed;
never reassign that origin to another workspace, because browsers retain app data.

Register the exact `<origin>/callback` in the application's development OAuth
provider. Set the app's callback variable as a workspace environment override;
project defaults remain shared. Restart only the application's process to load
changed variables. Do not run Clean setup or reseed its database.

A one-time launch grant becomes a root, host-only, Secure, HttpOnly preview cookie.
Every HTTP request rechecks expiration, revocation and organization membership,
then checks the exact organization/project/workspace/service binding. App cookies
are forwarded separately; they cannot overwrite or read the Facility grant.
Cookie Domain attributes are removed so app cookies remain on that preview host.
The proxy preserves payload bytes, application headers and root paths, and supplies
the configured external host/protocol to the app. Control-plane routes and Facility
session resolution remain inaccessible through these origins.

The API omits query strings from access logs because OAuth codes and launch tokens
are credentials. External proxies and the application itself must follow the same
rule. Default CI uses deterministic local HTTP/WebSocket servers and a disposable
Postgres database; no live OAuth provider or cloud credentials are required.
