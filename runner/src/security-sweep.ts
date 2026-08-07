import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const INPUT_MAX_AGE_MS = 60 * 60 * 1_000;
const INPUT_FUTURE_TOLERANCE_MS = 60 * 1_000;
const EVIDENCE_FILE_MAX_BYTES = 256 * 1024;

const REMOTE_SOURCE_FILES = {
  codeScanning: "code-scanning.json",
  dependabot: "dependabot.json",
  secretScanning: "secret-scanning.json",
  sbom: "sbom.json",
} as const;

export type SecuritySweepExpectedProvenance = {
  runId: string;
  owner: string;
  repo: string;
  ref: string;
  headSha: string;
};

export type SecuritySweepLocalEvidence = {
  workflowPermissions: string;
  guards: unknown;
  weekDiff: string;
};

export type PreparedSecuritySweepEvidence = {
  directory: string;
  expectedFiles: ReadonlyMap<string, string>;
};

export async function prepareSecuritySweepEvidence(input: {
  cwd: string;
  raw: unknown;
  expected: SecuritySweepExpectedProvenance;
  local: SecuritySweepLocalEvidence;
  now?: Date;
}): Promise<PreparedSecuritySweepEvidence> {
  const now = input.now ?? new Date();
  const evidence = validateSecuritySweepInput(input.raw, input.expected, now);
  const directory = join(input.cwd, ".facility-sweep");
  if (await pathExists(directory)) throw new Error("security_sweep_directory_already_exists");

  const files = new Map<string, string>();
  for (const [source, filename] of Object.entries(REMOTE_SOURCE_FILES)) {
    files.set(filename, `${canonicalJson(evidence.sources[source])}\n`);
  }
  files.set("workflow-permissions.txt", boundedText(input.local.workflowPermissions));
  files.set("guards.json", `${canonicalJson(input.local.guards)}\n`);
  files.set("week-diff.txt", boundedText(input.local.weekDiff));

  const hashes = Object.fromEntries(
    [...files].map(([filename, contents]) => [filename, sha256(contents)]),
  );
  files.set(
    "manifest.json",
    `${canonicalJson({
      schema: "facility.security.sweep.v1",
      run_id: evidence.runId,
      source_collected_at: evidence.collectedAt,
      prepared_at: now.toISOString(),
      repository: evidence.repository,
      files: hashes,
    })}\n`,
  );

  await mkdir(directory);
  for (const [filename, contents] of files) {
    await writeFile(join(directory, filename), contents, { flag: "wx" });
  }
  return { directory, expectedFiles: files };
}

export async function verifySecuritySweepEvidence(prepared: PreparedSecuritySweepEvidence) {
  try {
    for (const [filename, expected] of prepared.expectedFiles) {
      const path = join(prepared.directory, filename);
      const metadata = await lstat(path);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > EVIDENCE_FILE_MAX_BYTES
      ) {
        return false;
      }
      if ((await readFile(path, "utf8")) !== expected) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function validateSecuritySweepInput(
  raw: unknown,
  expected: SecuritySweepExpectedProvenance,
  now: Date,
) {
  const root = plainObject(raw);
  const repository = plainObject(root.repository);
  const sources = plainObject(root.sources);
  const collectedAt = stringValue(root.collectedAt);
  const collectedAtMs = Date.parse(collectedAt);
  if (
    root.schema !== "facility.security.sweep-input.v1" ||
    root.runId !== expected.runId ||
    repository.owner !== expected.owner ||
    repository.name !== expected.repo ||
    repository.ref !== expected.ref ||
    repository.headSha !== expected.headSha ||
    !Number.isFinite(collectedAtMs) ||
    collectedAtMs < now.getTime() - INPUT_MAX_AGE_MS ||
    collectedAtMs > now.getTime() + INPUT_FUTURE_TOLERANCE_MS
  ) {
    throw new Error("security_sweep_evidence_provenance_invalid");
  }

  for (const source of ["codeScanning", "dependabot", "secretScanning"] as const) {
    if (!validAlertSource(sources[source], REMOTE_SOURCE_FILES[source].replace(".json", ""))) {
      throw new Error(`security_sweep_evidence_${source}_invalid`);
    }
  }
  if (!validSbomSource(sources.sbom)) throw new Error("security_sweep_evidence_sbom_invalid");
  return {
    runId: expected.runId,
    collectedAt,
    repository: {
      owner: expected.owner,
      name: expected.repo,
      ref: expected.ref,
      head_sha: expected.headSha,
    },
    sources,
  };
}

function validAlertSource(value: unknown, source: string) {
  return Array.isArray(value) || validUnavailable(value, source);
}

function validSbomSource(value: unknown) {
  if (validUnavailable(value, "sbom")) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.hasOwn(value, "sbom");
}

function validUnavailable(value: unknown, source: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.unavailable === true && record.source === source && Boolean(stringValue(record.reason))
  );
}

function canonicalJson(value: unknown) {
  // Match the API's compact-JSON size budget. Pretty-printing here can push a
  // valid source over the same limit solely through indentation expansion.
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > EVIDENCE_FILE_MAX_BYTES) {
    throw new Error("security_sweep_evidence_file_too_large");
  }
  return serialized;
}

function boundedText(value: string) {
  if (Buffer.byteLength(value) > EVIDENCE_FILE_MAX_BYTES) {
    throw new Error("security_sweep_evidence_file_too_large");
  }
  return value;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
