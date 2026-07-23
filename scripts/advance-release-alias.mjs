/* global console, process */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  collectImmutableVersionsFromTagRecords,
  compareImmutableVersions,
  decideRollingMajorAlias
} from './verify-release-artifacts.mjs';

/** Throw-only helper failures: never log or set process.exitCode (main owns that). */
function abort(message) {
  throw new Error(message);
}

function parseImmutableCandidate(tag) {
  if (typeof tag !== 'string' || !/^v\d+\.\d+(\.\d+)?$/.test(tag)) {
    abort(`candidate tag ${tag} is not an accepted immutable Insights release tag`);
  }
  const version = tag.slice(1);
  const parts = version.split('.');
  if (parts.length === 2) {
    // minor tags are immutable only as vMAJOR.MINOR (patch implied 0)
    return { version: `${parts[0]}.${parts[1]}.0`, major: parts[0], tag };
  }
  return { version, major: parts[0], tag };
}

/**
 * Probe whether the rolling major alias exists on origin.
 * git ls-remote --exit-code: 0 = present, 2 = no match (absent); every other
 * nonzero status is a transport/auth/server failure and must fail closed.
 */
function probeRemoteAliasExists(runGit, majorAlias) {
  const result = runGit(['ls-remote', '--exit-code', '--refs', 'origin', `refs/tags/${majorAlias}`], {
    allowFailure: true
  });
  if (result.status === 0) return true;
  if (result.status === 2) return false;
  const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
  abort(
    `git ls-remote --exit-code --refs origin refs/tags/${majorAlias} failed` +
      (detail ? `: ${detail}` : ` (status ${result.status})`)
  );
}

function fetchScopedRefs(runGit, majorAlias) {
  // Fetch only the rolling alias and immutable comparison refs for that major.
  // Strict: any failure must throw before comparison/mutation.
  runGit([
    'fetch',
    '--no-tags',
    '--depth=1',
    'origin',
    `refs/tags/${majorAlias}:refs/tags/${majorAlias}`
  ]);
  runGit([
    'fetch',
    '--no-tags',
    '--depth=1',
    'origin',
    `refs/tags/${majorAlias}.*:refs/tags/${majorAlias}.*`
  ]);
}

function resolveAliasCommit(runGit, majorAlias) {
  const exists = runGit(['rev-parse', '-q', '--verify', `refs/tags/${majorAlias}`], { allowFailure: true });
  if (exists.status !== 0) return null;
  const peeled = runGit(['rev-parse', `${majorAlias}^{commit}`]);
  return peeled.stdout.trim();
}

function tagRecordsAtCommit(runGit, aliasCommit) {
  const listed = runGit([
    'for-each-ref',
    '--format=%(objecttype)\t%(refname:short)\t%(objectname)\t%(*objectname)',
    'refs/tags'
  ]);
  const records = [];
  for (const line of listed.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [objectType, name, objectName, peeledName] = line.split('\t');
    if (objectType === 'tag') {
      const commit = (peeledName || '').trim();
      if (commit === aliasCommit) {
        records.push({ name, commit, type: 'annotated' });
      }
    } else if (objectType === 'commit') {
      if (objectName === aliasCommit) {
        records.push({ name, commit: objectName, type: 'lightweight' });
      }
    }
  }
  return records;
}

export function planMajorAliasAdvance({ candidateTag, candidateCommit, runGit }) {
  if (typeof runGit !== 'function') {
    abort('planMajorAliasAdvance requires an injected runGit adapter');
  }
  const { version: candidateVersion, major, tag } = parseImmutableCandidate(candidateTag);
  if (!/^[0-9a-f]{40,64}$/i.test(String(candidateCommit ?? ''))) {
    abort(`candidate commit is not a valid git object name`);
  }
  const majorAlias = `v${major}`;
  // Only ls-remote no-match (status 2) may take the absent path. Transport/auth
  // failures fail closed above; a present alias must be fetched before compare.
  if (!probeRemoteAliasExists(runGit, majorAlias)) {
    return {
      action: 'advance',
      reason: 'absent',
      majorAlias,
      candidateTag: tag,
      candidateVersion,
      candidateCommit
    };
  }
  fetchScopedRefs(runGit, majorAlias);
  const aliasCommit = resolveAliasCommit(runGit, majorAlias);
  if (aliasCommit === null) {
    abort(
      `remote ${majorAlias} alias was reported present but could not be resolved locally after fetch`
    );
  }
  const records = tagRecordsAtCommit(runGit, aliasCommit);
  const immutableVersionsAtAlias = collectImmutableVersionsFromTagRecords(records, {
    major,
    aliasCommit
  });
  const decision = decideRollingMajorAlias({ candidateVersion, immutableVersionsAtAlias });
  return {
    ...decision,
    majorAlias,
    candidateTag: tag,
    candidateVersion,
    candidateCommit,
    aliasCommit,
    immutableVersionsAtAlias,
    records
  };
}

function advanceAlias(runGit, { majorAlias, candidateTag, candidateCommit }) {
  runGit(['config', 'user.name', 'github-actions[bot]']);
  runGit(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  // Force-update only the rolling major alias; never mutate immutable tags.
  runGit(['tag', '-fa', majorAlias, '-m', `Rolling ${majorAlias} alias -> ${candidateTag}`, candidateCommit]);
  runGit(['push', 'origin', `refs/tags/${majorAlias}`, '--force']);
}

/**
 * Orchestrate plan + optional alias advance with an injected Git adapter.
 * Failures throw without logging or setting process.exitCode.
 */
export function runMajorAliasAdvance({ candidateTag, candidateCommit, runGit, logger = console }) {
  if (typeof runGit !== 'function') {
    abort('runMajorAliasAdvance requires an injected runGit adapter');
  }
  const plan = planMajorAliasAdvance({ candidateTag, candidateCommit, runGit });
  if (plan.action === 'fail') {
    abort(
      `existing ${plan.majorAlias} alias at ${plan.aliasCommit} cannot be tied to an immutable version; refusing to move the rolling alias`
    );
  }
  if (plan.action === 'skip') {
    logger.log(
      `::notice::Not moving ${plan.majorAlias}; newer immutable version ${plan.version} is present (candidate ${plan.candidateVersion}).`
    );
    return plan;
  }
  // same/older/absent => advance
  if (plan.immutableVersionsAtAlias?.some((version) => compareImmutableVersions(version, plan.candidateVersion) === 0)) {
    logger.log(`::notice::Refreshing ${plan.majorAlias} at same immutable version ${plan.candidateVersion}.`);
  }
  advanceAlias(runGit, {
    majorAlias: plan.majorAlias,
    candidateTag: plan.candidateTag,
    candidateCommit: plan.candidateCommit
  });
  logger.log(`::notice::Advanced ${plan.majorAlias} -> ${plan.candidateTag} (${plan.candidateCommit}).`);
  return plan;
}

function createSpawnGit() {
  return function runGit(args, { allowFailure = false } = {}) {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0 && !allowFailure) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
      abort(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    }
    return result;
  };
}

function main() {
  runMajorAliasAdvance({
    candidateTag: process.env.GITHUB_REF_NAME,
    candidateCommit: process.env.GITHUB_SHA,
    runGit: createSpawnGit(),
    logger: console
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
