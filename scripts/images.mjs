#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: this CLI consumes GitHub Actions' runtime contract outside Turbo tasks.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseCandidate } from "./release.mjs";

export const BUILD_IMAGES = Object.freeze(["api", "web", "runner"]);
export const PUBLISHED_IMAGES = Object.freeze(["api", "worker", "web", "runner"]);
export const GITHUB_API_URL = "https://api.github.com/";

const BAKE_AUXILIARY_TARGETS = new Set(["service-packages"]);

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DOCKER_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const GITHUB_SHA_PATTERN = /^[0-9a-f]{40,64}$/;

export function publicationPlan({ eventName, ref, visibility, sha, release }) {
  if (!GITHUB_SHA_PATTERN.test(sha || "")) {
    throw new Error("image publication requires a full lowercase GitHub commit SHA");
  }
  const shaTag = `sha-${sha.slice(0, 12)}`;

  if (eventName === "workflow_dispatch") {
    return { mode: "manual", tags: [shaTag] };
  }
  if (eventName !== "push") {
    throw new Error(`image publication does not accept ${eventName || "a missing event"}`);
  }
  if (visibility !== "public") {
    throw new Error("release image publication is disabled until the repository is public");
  }
  if (!release || typeof release.version !== "string" || typeof release.tag !== "string") {
    throw new Error("release image publication requires a validated release");
  }
  if (release.tag !== `v${release.version}`) {
    throw new Error(`validated release tag ${release.tag} does not match v${release.version}`);
  }
  if (ref !== "refs/heads/main") {
    throw new Error(`release images come from main, not ${ref || "an unknown ref"}`);
  }
  assertDockerTag(release.version);
  return { mode: "release", tags: [shaTag, release.version] };
}

export function validateRepositoryIdentity({ repository, owner, ownerType }) {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(
    repository || "",
  );
  if (!match) throw new Error(`invalid GitHub repository identity: ${repository || "missing"}`);
  if (!owner || match[1].toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `repository ${repository} does not belong to expected owner ${owner || "missing"}`,
    );
  }
  if (ownerType !== "Organization" && ownerType !== "User") {
    throw new Error(`unsupported GitHub repository owner type: ${ownerType || "missing"}`);
  }
  return {
    owner: match[1],
    ownerType,
    repository: `${match[1]}/${match[2]}`.toLowerCase(),
    repositoryName: match[2].toLowerCase(),
  };
}

export function parseTagsJson(value) {
  let tags;
  try {
    tags = JSON.parse(value);
  } catch (error) {
    throw new Error(`image tag plan is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > 2) {
    throw new Error("image tag plan must contain one or two tags");
  }
  for (const tag of tags) assertDockerTag(tag);
  if (new Set(tags).size !== tags.length)
    throw new Error("image tag plan contains a duplicate tag");
  return tags;
}

export function recordDigest({ image, digest, directory }) {
  if (!BUILD_IMAGES.includes(image))
    throw new Error(`unsupported build image: ${image || "missing"}`);
  assertDigest(digest);
  const destination = resolve(directory);
  mkdirSync(destination, { recursive: true });
  const path = join(destination, `${image}.json`);
  writeFileSync(path, `${JSON.stringify({ image, digest })}\n`, { mode: 0o600 });
  return path;
}

export function loadDigests(directory) {
  const digests = new Map();
  for (const expectedImage of BUILD_IMAGES) {
    const path = join(resolve(directory), `${expectedImage}.json`);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`cannot read digest manifest for ${expectedImage}: ${error.message}`);
    }
    if (manifest?.image !== expectedImage) {
      throw new Error(
        `digest manifest ${path} names ${manifest?.image || "no image"}, expected ${expectedImage}`,
      );
    }
    assertDigest(manifest.digest);
    digests.set(expectedImage, manifest.digest);
  }
  return digests;
}

export function recordBakeDigests({ metadata, directory }) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Bake metadata must be an object keyed by image target");
  }
  const allTargets = Object.keys(metadata).sort();
  const targets = allTargets.filter((target) => !BAKE_AUXILIARY_TARGETS.has(target));
  const expected = [...BUILD_IMAGES].sort();
  if (JSON.stringify(targets) !== JSON.stringify(expected)) {
    throw new Error(
      `Bake metadata targets ${allTargets.join(",") || "none"}; expected ${expected.join(",")} plus optional service-packages`,
    );
  }

  const paths = [];
  for (const image of BUILD_IMAGES) {
    const result = metadata[image];
    const digest = result?.["containerimage.digest"];
    const descriptorDigest = result?.["containerimage.descriptor"]?.digest;
    assertDigest(digest);
    if (descriptorDigest !== digest) {
      throw new Error(`Bake metadata descriptor for ${image} does not match ${digest}`);
    }
    paths.push(recordDigest({ image, digest, directory }));
  }
  return paths;
}

export async function inspectPublication({
  repository,
  owner,
  ownerType,
  token,
  tags,
  digests,
  apiBaseUrl = GITHUB_API_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
}) {
  const identity = validateRepositoryIdentity({ repository, owner, ownerType });
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("GITHUB_TOKEN is required to inspect existing image tags");
  }
  const checkedTags = Array.isArray(tags)
    ? parseTagsJson(JSON.stringify(tags))
    : parseTagsJson(tags);
  const desired = [];

  for (const image of PUBLISHED_IMAGES) {
    const sourceImage = image === "worker" ? "api" : image;
    const digest = digests.get(sourceImage);
    assertDigest(digest);
    const packageName = `${identity.repositoryName}/${image}`;
    const versions = await packageVersions({
      apiBaseUrl,
      fetchImpl,
      identity,
      packageName,
      timeoutMs,
      token,
    });
    const existingTags = new Map();
    for (const version of versions) {
      for (const tag of version.tags) {
        if (existingTags.has(tag) && existingTags.get(tag) !== version.digest) {
          throw new Error(`${packageName}:${tag} points at more than one digest`);
        }
        existingTags.set(tag, version.digest);
      }
    }

    const missingTags = [];
    for (const tag of checkedTags) {
      const existingDigest = existingTags.get(tag);
      if (existingDigest && existingDigest !== digest) {
        throw new Error(
          `refusing to replace ${packageName}:${tag}: existing ${existingDigest}, candidate ${digest}`,
        );
      }
      if (!existingDigest) missingTags.push(tag);
    }
    desired.push({ digest, image, missingTags, sourceImage });
  }

  return { identity, images: desired, tags: checkedTags };
}

export async function publishImageSet({
  repository,
  owner,
  ownerType,
  token,
  tags,
  digests,
  apiBaseUrl = GITHUB_API_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  dockerCommand = "docker",
  spawn = spawnSync,
  env = process.env,
}) {
  const plan = await inspectPublication({
    repository,
    owner,
    ownerType,
    token,
    tags,
    digests,
    apiBaseUrl,
    fetchImpl,
    timeoutMs,
  });
  const registry = `ghcr.io/${plan.identity.repository}`;
  const childEnv = scrubPublicationCredentials({ ...env });
  let promoted = 0;

  for (const image of plan.images) {
    if (image.missingTags.length === 0) continue;
    // A single-platform source is already the exact deployable manifest.
    // Buildx otherwise wraps it in a new index with a different digest, which
    // makes an identical immutable-tag replay look like changed runtime bytes.
    const args = ["buildx", "imagetools", "create", "--prefer-index=false"];
    for (const tag of image.missingTags) {
      args.push("--tag", `${registry}/${image.image}:${tag}`);
    }
    args.push(`${registry}/${image.sourceImage}@${image.digest}`);
    const result = spawn(dockerCommand, args, { env: childEnv, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `image promotion failed for ${image.image} with exit ${result.status ?? "unknown"}`,
      );
    }
    promoted += 1;
  }
  return { ...plan, promoted };
}

async function packageVersions({ apiBaseUrl, fetchImpl, identity, packageName, timeoutMs, token }) {
  const base = normalizeApiBase(apiBaseUrl);
  const namespace = identity.ownerType === "Organization" ? "orgs" : "users";
  const versions = [];

  for (let page = 1; page <= 100; page += 1) {
    const url = new URL(
      `${namespace}/${encodeURIComponent(identity.owner)}/packages/container/${encodeURIComponent(packageName)}/versions`,
      base,
    );
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`GitHub Packages lookup failed closed for ${packageName}: ${error.message}`);
    }
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new Error(
        `GitHub Packages lookup failed closed for ${packageName} with HTTP ${response.status}`,
      );
    }

    let pageVersions;
    try {
      pageVersions = await response.json();
    } catch (error) {
      throw new Error(
        `GitHub Packages returned malformed metadata for ${packageName}: ${error.message}`,
      );
    }
    if (!Array.isArray(pageVersions)) {
      throw new Error(`GitHub Packages returned malformed metadata for ${packageName}`);
    }
    for (const version of pageVersions) {
      if (
        !version ||
        typeof version !== "object" ||
        !DIGEST_PATTERN.test(version.name || "") ||
        version.metadata?.package_type !== "container" ||
        !Array.isArray(version.metadata?.container?.tags) ||
        version.metadata.container.tags.some(
          (tag) => typeof tag !== "string" || !DOCKER_TAG_PATTERN.test(tag),
        )
      ) {
        throw new Error(`GitHub Packages returned malformed metadata for ${packageName}`);
      }
      versions.push({ digest: version.name, tags: version.metadata.container.tags });
    }
    if (pageVersions.length < 100) return versions;
  }
  throw new Error(`GitHub Packages pagination exceeded the safe limit for ${packageName}`);
}

function normalizeApiBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid GitHub API URL: ${value}`);
  }
  if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/")) {
    throw new Error("GitHub API URL must not contain credentials, a query, or a fragment");
  }
  return url;
}

function assertDigest(digest) {
  if (!DIGEST_PATTERN.test(digest || "")) {
    throw new Error(`invalid container digest: ${digest || "missing"}`);
  }
}

function assertDockerTag(tag) {
  if (typeof tag !== "string" || !DOCKER_TAG_PATTERN.test(tag)) {
    throw new Error(`invalid container tag: ${tag || "missing"}`);
  }
}

function scrubPublicationCredentials(env) {
  for (const key of [
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    delete env[key];
  }
  return env;
}

function output(values) {
  for (const [key, value] of Object.entries(values)) {
    if (/\r|\n/.test(String(value))) {
      throw new Error(`GitHub output ${key} contains a forbidden line break`);
    }
  }
  const rendered = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${rendered}\n`);
  console.log(JSON.stringify(values));
}

async function main([command, ...args]) {
  if (command === "plan") {
    if (args.length > 0) throw new Error("plan does not accept arguments");
    const eventName = process.env.GITHUB_EVENT_NAME;
    const release = eventName === "push" ? validateReleaseCandidate() : undefined;
    const plan = publicationPlan({
      eventName,
      ref: process.env.GITHUB_REF,
      visibility: process.env.GITHUB_REPOSITORY_VISIBILITY,
      sha: process.env.GITHUB_SHA,
      release,
    });
    output({ mode: plan.mode, tags: JSON.stringify(plan.tags) });
    return;
  }

  if (command === "record-digest") {
    if (args.length !== 3) throw new Error("record-digest requires image, digest, and directory");
    const path = recordDigest({ image: args[0], digest: args[1], directory: args[2] });
    console.log(path);
    return;
  }

  if (command === "record-bake-digests") {
    if (args.length !== 2) {
      throw new Error("record-bake-digests requires metadata file and digest-manifest directory");
    }
    let metadata;
    try {
      metadata = JSON.parse(readFileSync(resolve(args[0]), "utf8"));
    } catch (error) {
      throw new Error(`cannot read Bake metadata: ${error.message}`);
    }
    for (const path of recordBakeDigests({ metadata, directory: args[1] })) console.log(path);
    return;
  }

  if (command === "promote") {
    if (args.length !== 1) throw new Error("promote requires the digest-manifest directory");
    const result = await publishImageSet({
      repository: process.env.GITHUB_REPOSITORY,
      owner: process.env.GITHUB_REPOSITORY_OWNER,
      ownerType: process.env.GITHUB_REPOSITORY_OWNER_TYPE,
      token: process.env.GITHUB_TOKEN,
      tags: process.env.IMAGE_TAGS_JSON,
      digests: loadDigests(args[0]),
    });
    output({ promoted: result.promoted, tags: JSON.stringify(result.tags) });
    return;
  }

  throw new Error(`unknown image command: ${command || "missing"}`);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
