/* global console, process */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function fail(message) {
  throw new Error(`release artifact verification failed: ${message}`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Insights immutable tags: `v<full version>` or `v<major>.<minor>` only when patch is 0. */
export function isInsightsImmutableTagForVersion(tag, packageVersion) {
  if (typeof tag !== 'string' || typeof packageVersion !== 'string') return false;
  if (!/^\d+\.\d+\.\d+$/.test(packageVersion)) return false;
  if (tag === `v${packageVersion}`) return true;
  const [major, minor, patch] = packageVersion.split('.');
  return patch === '0' && tag === `v${major}.${minor}`;
}

export function assertInsightsImmutableTagVersionBinding(tag, packageVersion) {
  if (!isInsightsImmutableTagForVersion(tag, packageVersion)) {
    fail(`tag ${tag} is not an accepted immutable form for version ${packageVersion}`);
  }
}

/** True only for an explicit npm E404; outage/auth/timeout/generic errors return false. */
export function isExplicitNpmE404(output) {
  const text = String(output ?? '');
  return /(?:^|\n)npm (?:error|ERR!) code E404(?:\n|$)/m.test(text) || /(?:^|\n)npm error 404\b/m.test(text);
}

export function computeSha512Sri(filePath) {
  return `sha512-${createHash('sha512').update(readFileSync(filePath)).digest('base64')}`;
}

export function verifySha512Sri(filePath, expectedSri) {
  const actual = computeSha512Sri(filePath);
  if (actual !== String(expectedSri ?? '').trim()) {
    fail('published npm integrity differs from staged tarball');
  }
  return actual;
}

/** Semantic compare of immutable versions (`X.Y.Z` or `X.Y` as `X.Y.0`). Negative if a<b. */
export function compareImmutableVersions(a, b) {
  const parse = (value) => {
    const raw = String(value ?? '').replace(/^v/, '');
    const parts = raw.split('.').map((part) => Number(part));
    if (parts.length === 2) parts.push(0);
    if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0 || Number.isNaN(n))) {
      throw new Error(`invalid immutable version: ${value}`);
    }
    return parts;
  };
  const [aMajor, aMinor, aPatch] = parse(a);
  const [bMajor, bMinor, bPatch] = parse(b);
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
  return 0;
}

/**
 * Collect immutable versions from annotated/lightweight tag records at the alias commit.
 * Each record: { name, commit, type: 'annotated' | 'lightweight' }.
 */
export function collectImmutableVersionsFromTagRecords(tagRecords, { major, aliasCommit }) {
  if (!Array.isArray(tagRecords)) return [];
  const majorPrefix = `v${major}.`;
  return tagRecords
    .filter((record) => record && record.commit === aliasCommit && typeof record.name === 'string')
    .map((record) => record.name)
    .filter((name) => name.startsWith(majorPrefix))
    .map((name) => name.slice(1))
    .filter((version) => /^\d+\.\d+(\.\d+)?$/.test(version));
}

/**
 * Decide rolling major-alias action from pure version data.
 * `immutableVersionsAtAlias` null/undefined => absent alias; empty => untied/fail-safe.
 */
export function decideRollingMajorAlias({ candidateVersion, immutableVersionsAtAlias }) {
  if (immutableVersionsAtAlias === undefined || immutableVersionsAtAlias === null) {
    return { action: 'advance', reason: 'absent' };
  }
  if (!Array.isArray(immutableVersionsAtAlias) || immutableVersionsAtAlias.length === 0) {
    return { action: 'fail', reason: 'untied' };
  }
  for (const version of immutableVersionsAtAlias) {
    if (compareImmutableVersions(version, candidateVersion) > 0) {
      return { action: 'skip', reason: 'newer', version };
    }
  }
  return { action: 'advance', reason: 'same-or-older' };
}

export function verifyReleaseArtifacts({ directory, repository, commitSha, tag, packageName, packageVersion }) {
  const manifestPath = join(directory, 'release-manifest.json');
  if (!existsSync(manifestPath)) fail('missing release-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schema_version !== 1) fail('unsupported manifest schema_version');
  for (const [field, expected] of Object.entries({
    repository,
    commit_sha: commitSha,
    tag,
    package_name: packageName,
    package_version: packageVersion
  })) {
    if (manifest[field] !== expected) fail(`${field} does not match`);
  }
  assertInsightsImmutableTagVersionBinding(tag, packageVersion);
  assertInsightsImmutableTagVersionBinding(manifest.tag, manifest.package_version);
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) fail('missing artifacts');
  for (const artifact of manifest.artifacts) {
    if (typeof artifact.path !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(artifact.path)) fail('invalid artifact path');
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) fail(`invalid checksum for ${artifact.path}`);
  }
  const expectedPaths = new Set(['release-manifest.json', ...manifest.artifacts.map((artifact) => artifact.path)]);
  const actualPaths = readdirSync(directory);
  if (actualPaths.some((path) => !expectedPaths.has(path)) || expectedPaths.size !== actualPaths.length) fail('artifact allowlist mismatch');
  for (const artifact of manifest.artifacts) {
    const path = join(directory, artifact.path);
    if (!existsSync(path)) fail(`missing ${artifact.path}`);
    if (sha256(path) !== artifact.sha256) fail(`checksum mismatch for ${artifact.path}`);
  }
  return manifest;
}

function printHelp() {
  console.log(`Usage: node scripts/verify-release-artifacts.mjs <directory> <packageName> <packageVersion>
       node scripts/verify-release-artifacts.mjs --help

Modes:
  verify   Validate release.tgz + release-manifest.json identity, allowlist, checksums,
           and Insights immutable tag/version binding (default when arguments are provided).
  help     Print this message and exit 0.

Exported pure helpers (importable): isInsightsImmutableTagForVersion,
assertInsightsImmutableTagVersionBinding, isExplicitNpmE404, computeSha512Sri,
verifySha512Sri, compareImmutableVersions, collectImmutableVersionsFromTagRecords,
decideRollingMajorAlias, verifyReleaseArtifacts.`);
}

if (import.meta.main) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    process.exitCode = 0;
  } else {
    const [directory = '.', packageName, packageVersion] = process.argv.slice(2);
    try {
      verifyReleaseArtifacts({
        directory,
        repository: process.env.GITHUB_REPOSITORY,
        commitSha: process.env.GITHUB_SHA,
        tag: process.env.GITHUB_REF_NAME,
        packageName,
        packageVersion
      });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
