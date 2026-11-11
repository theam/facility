---
title: Give files to a story agent
description: Attach private input files through Facility's UI or MCP without putting their contents in Git or every prompt.
---

Input files belong to one existing story, including stories created directly in
Facility without a GitHub issue. They live outside the repository in that
story's persistent workspace volume. Uploading does not start an agent, approve
a plan, import knowledge, or authorize external operations.

## In the web app

1. Open the story's reply composer and select **attach files**.
2. Choose files. If the workspace is sleeping, explicitly allow resuming compute
   before uploading. This may incur workspace compute costs, but no inference.
3. Wait for **available**, select up to five files, write your instructions and
   send the message to the intended agent.

The agent receives file names, hashes and local paths, not the entire contents
in its prompt. It can read them with its native tools. Available means Facility
verified the stored bytes; a message reference or successful turn is not proof
that the agent read or understood every file.

Metadata listing never wakes a workspace. Downloads need running compute and
workspace read permission. Files download as attachments, never inline HTML.

## Through MCP

Call `facility_prepare_file_upload` with the story, filename, byte count,
SHA-256, media type and a stable idempotency key. `resume: true` explicitly
permits resuming sleeping compute for this transfer. It defaults to false.

The response contains a ten-minute, single-file HTTP PUT URL and headers. Upload
the actual local bytes with your client's HTTP/file capability, using
`application/octet-stream` and the returned `x-facility-file-token` header.
Do not paste a large base64 string into a tool argument. A local filesystem
path on your computer is not a path the remote MCP server can read.

Treat the transfer token as a credential. Do not publish it or put it in logs.
It cannot access other files or API operations, and current permission is
checked again on upload. A completed upload consumes its grant. If a response
is lost, inspect `facility_list_input_files` before retrying.

When the file is available, pass its ID in `attachmentIds` to
`facility_send_message`. Only this explicit send queues the native agent.
File attachments do not give no-tools consultations workspace access.

## TypeScript SDK

The repository's `FacilityClient.put` accepts `ArrayBuffer`, typed-array views
and `Blob` bodies for the binary upload route. Pass the prepared upload's headers
in the request options. Do not JSON-stringify or base64-encode the file.
`FacilityClient.get` returns an `ArrayBuffer` for the binary download route.
Both encodings are declared as `application/octet-stream` in OpenAPI.

Binary uploads are never automatically retried, even with an idempotency key:
the file capability is single-use. If a response is lost, read the file's metadata
before preparing another transfer. JSON requests keep their existing retry policy.

## Limits and retention

- 25 MiB per file, five files per message, and 100 MiB / 100 retained file
  reservations per story.
- Project storage defaults to 250 MiB. Operators can configure
  `FACILITY_INPUT_PROJECT_MAX_BYTES` without changing other API body limits.
- Filenames cannot contain paths or control characters. All contents are
  untrusted data; archives are never automatically unpacked or executed.
- Failed or expired uploads retain their reservation until explicitly deleted.
  This prevents interrupted storage writes from bypassing quota. Delete unused
  reservations from the UI or with `facility_remove_input_file`; cleanup can
  explicitly resume compute when necessary.
- Per-file private staging is cleaned after transfers and on explicit discard,
  including remnants of interrupted transfers. A cleanup failure is reported,
  not treated as a successful available upload.
- Suspension and archive retain input files. Explicit workspace destruction
  removes their volume and releases their reservations. Backups of the volume
  include input files.

Deleting one input file makes earlier references unavailable. It cannot erase
data the agent already read into its model context. Native workspaces are
trusted compute: authorized story agents share their volume; this is not a
per-agent filesystem permission boundary. Do not upload secrets as documents.

## GitHub and knowledge imports are separate

A link to an issue attachment is not proof that the agent can download it.
Private attachment access depends on the actual GitHub authentication flow;
Actions artifacts additionally have their own permissions and retention.
This delivery does not add an arbitrary-URL download proxy or require a manual
story to create a GitHub issue.

An uploaded configuration or document is only an input. A knowledge snapshot
containing chunks and metadata is not a restore payload: do not ingest its JSON
wrapper as a document. Importing knowledge or running evaluations needs its own
task instructions and authorization.
