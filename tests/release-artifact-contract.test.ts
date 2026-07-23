import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertInsightsImmutableTagVersionBinding,
  collectImmutableVersionsFromTagRecords,
  compareImmutableVersions,
  computeSha512Sri,
  decideRollingMajorAlias,
  isExplicitNpmE404,
  isInsightsImmutableTagForVersion,
  verifyReleaseArtifacts,
  verifySha512Sri
  // @ts-expect-error The release verifier is deliberately dependency-free ESM.
} from '../scripts/verify-release-artifacts.mjs';
import {
  createSpawnGit,
  GIT_COMMAND_MAX_BUFFER,
  GIT_COMMAND_TIMEOUT_MS,
  runMajorAliasAdvance
  // @ts-expect-error The alias advance script is deliberately dependency-free ESM.
} from '../scripts/advance-release-alias.mjs';

const SHA = createHash('sha256').update('tarball').digest('hex');
const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

function fixture(overrides: Record<string, unknown> = {}, options: { extraFile?: string; omitTarball?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'release-artifact-'));
  if (!options.omitTarball) writeFileSync(join(directory, 'release.tgz'), 'tarball');
  if (options.extraFile) writeFileSync(join(directory, options.extraFile), 'extra');
  writeFileSync(
    join(directory, 'release-manifest.json'),
    JSON.stringify({
      schema_version: 1,
      repository: 'postman-cs/postman-insights-onboarding-action',
      commit_sha: 'abc123',
      tag: 'v2.1.4',
      package_name: '@postman-cse/onboarding-insights',
      package_version: '2.1.4',
      artifacts: [{ path: 'release.tgz', sha256: SHA }],
      ...overrides
    })
  );
  return directory;
}

function verify(directory: string, overrides: Record<string, string> = {}) {
  return verifyReleaseArtifacts({
    directory,
    repository: 'postman-cs/postman-insights-onboarding-action',
    commitSha: 'abc123',
    tag: 'v2.1.4',
    packageName: '@postman-cse/onboarding-insights',
    packageVersion: '2.1.4',
    ...overrides
  });
}

describe('release artifact verifier', () => {
  it('accepts a manifest whose identity and checksums match', () => {
    const directory = fixture();
    expect(() => verify(directory)).not.toThrow();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    ['repository', 'wrong/repository'],
    ['commit_sha', 'wrong-sha'],
    ['tag', 'v9.9.9'],
    ['package_name', '@wrong/package'],
    ['package_version', '9.9.9'],
    ['artifacts', [{ path: 'release.tgz', sha256: '0'.repeat(64) }]]
  ])('rejects a mismatched %s', (field, value) => {
    const directory = fixture({ [field]: value });
    expect(() => verify(directory)).toThrow();
    rmSync(directory, { recursive: true, force: true });
  });

  it('rejects missing, extra, and path-invalid artifacts', () => {
    const missing = fixture({}, { omitTarball: true });
    expect(() => verify(missing)).toThrow(/missing release\.tgz|checksum|allowlist/i);
    rmSync(missing, { recursive: true, force: true });

    const extra = fixture({}, { extraFile: 'evil.bin' });
    expect(() => verify(extra)).toThrow(/allowlist/i);
    rmSync(extra, { recursive: true, force: true });

    const invalidPath = fixture({ artifacts: [{ path: '../escape.tgz', sha256: SHA }] });
    expect(() => verify(invalidPath)).toThrow(/invalid artifact path/i);
    rmSync(invalidPath, { recursive: true, force: true });
  });

  it('rejects any manifest artifact set other than exactly one release.tgz', () => {
    const extraSha = createHash('sha256').update('extra').digest('hex');
    const declaredExtra = fixture(
      {
        artifacts: [
          { path: 'release.tgz', sha256: SHA },
          { path: 'extra.bin', sha256: extraSha }
        ]
      },
      { extraFile: 'extra.bin' }
    );
    expect(() => verify(declaredExtra)).toThrow(/exactly one release\.tgz/i);
    rmSync(declaredExtra, { recursive: true, force: true });

    const duplicate = fixture({
      artifacts: [
        { path: 'release.tgz', sha256: SHA },
        { path: 'release.tgz', sha256: SHA }
      ]
    });
    expect(() => verify(duplicate)).toThrow(/exactly one release\.tgz/i);
    rmSync(duplicate, { recursive: true, force: true });

    const wrongOnly = fixture({ artifacts: [{ path: 'other.tgz', sha256: SHA }] });
    expect(() => verify(wrongOnly)).toThrow(/exactly release\.tgz/i);
    rmSync(wrongOnly, { recursive: true, force: true });

    const empty = fixture({ artifacts: [] });
    expect(() => verify(empty)).toThrow(/exactly one release\.tgz/i);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('insights immutable tag/version binding', () => {
  it('accepts full versions and zero-patch minor tags', () => {
    expect(isInsightsImmutableTagForVersion('v2.1.4', '2.1.4')).toBe(true);
    expect(isInsightsImmutableTagForVersion('v2.1.0', '2.1.0')).toBe(true);
    expect(isInsightsImmutableTagForVersion('v2.1', '2.1.0')).toBe(true);
    expect(() => assertInsightsImmutableTagVersionBinding('v2.1', '2.1.0')).not.toThrow();
  });

  it('rejects mismatched and disallowed tags', () => {
    expect(isInsightsImmutableTagForVersion('v2.1', '2.1.4')).toBe(false);
    expect(isInsightsImmutableTagForVersion('v2', '2.1.4')).toBe(false);
    expect(isInsightsImmutableTagForVersion('v2.1.5', '2.1.4')).toBe(false);
    expect(isInsightsImmutableTagForVersion('2.1.4', '2.1.4')).toBe(false);
    expect(() => assertInsightsImmutableTagVersionBinding('v2.1', '2.1.4')).toThrow();

    const directory = fixture({ tag: 'v2.1', package_version: '2.1.4' });
    expect(() => verify(directory, { tag: 'v2.1', packageVersion: '2.1.4' })).toThrow();
    rmSync(directory, { recursive: true, force: true });
  });
});

describe('npm E404 and SRI helpers', () => {
  it('distinguishes explicit E404 from outage, auth, and generic errors', () => {
    expect(isExplicitNpmE404('npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/pkg')).toBe(true);
    expect(isExplicitNpmE404('npm ERR! code E404\nnpm ERR! 404 Not Found')).toBe(true);
    expect(isExplicitNpmE404('npm error code ETIMEDOUT')).toBe(false);
    expect(isExplicitNpmE404('npm error code E401\nnpm error 401 Unauthorized')).toBe(false);
    expect(isExplicitNpmE404('npm error code E403')).toBe(false);
    expect(isExplicitNpmE404('network socket hang up')).toBe(false);
    expect(isExplicitNpmE404('')).toBe(false);
  });

  it('computes and verifies SHA-512 SRI for equal and mismatched digests', () => {
    const directory = fixture();
    const tarball = join(directory, 'release.tgz');
    const sri = computeSha512Sri(tarball);
    expect(sri).toMatch(/^sha512-[A-Za-z0-9+/=]+$/);
    expect(() => verifySha512Sri(tarball, sri)).not.toThrow();
    expect(() => verifySha512Sri(tarball, 'sha512-AAAAAAAAAAAAAAAAAAAAAA==')).toThrow(/integrity/i);
    rmSync(directory, { recursive: true, force: true });
  });
});

describe('semantic rolling major alias helpers', () => {
  it('compares immutable versions and decides advance/skip/fail for annotated and lightweight records', () => {
    expect(compareImmutableVersions('2.1.4', '2.1.5')).toBe(-1);
    expect(compareImmutableVersions('2.2.0', '2.1.9')).toBe(1);
    expect(compareImmutableVersions('2.1', '2.1.0')).toBe(0);

    const aliasCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const annotatedNewer = collectImmutableVersionsFromTagRecords(
      [
        { name: 'v2', commit: aliasCommit, type: 'annotated' },
        { name: 'v2.1.9', commit: aliasCommit, type: 'annotated' }
      ],
      { major: '2', aliasCommit }
    );
    expect(annotatedNewer).toEqual(['2.1.9']);
    expect(decideRollingMajorAlias({ candidateVersion: '2.1.4', immutableVersionsAtAlias: annotatedNewer })).toEqual({
      action: 'skip',
      reason: 'newer',
      version: '2.1.9'
    });

    const lightweightOlder = collectImmutableVersionsFromTagRecords(
      [
        { name: 'v2.0.1', commit: aliasCommit, type: 'lightweight' },
        { name: 'v2.1.4', commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', type: 'lightweight' }
      ],
      { major: '2', aliasCommit }
    );
    expect(lightweightOlder).toEqual(['2.0.1']);
    expect(decideRollingMajorAlias({ candidateVersion: '2.1.4', immutableVersionsAtAlias: lightweightOlder })).toEqual({
      action: 'advance',
      reason: 'same-or-older'
    });

    expect(decideRollingMajorAlias({ candidateVersion: '2.1.4', immutableVersionsAtAlias: ['2.1.4'] })).toEqual({
      action: 'advance',
      reason: 'same-or-older'
    });
    expect(decideRollingMajorAlias({ candidateVersion: '2.1.4', immutableVersionsAtAlias: null })).toEqual({
      action: 'advance',
      reason: 'absent'
    });
    expect(decideRollingMajorAlias({ candidateVersion: '2.1.4', immutableVersionsAtAlias: [] })).toEqual({
      action: 'fail',
      reason: 'untied'
    });
  });

  it('orders components above Number.MAX_SAFE_INTEGER exactly and skips a newer huge alias', () => {
    const olderHuge = '2.9007199254740992.0';
    const newerHuge = '2.9007199254740993.0';
    expect(Number('9007199254740992')).toBe(Number('9007199254740993'));
    expect(compareImmutableVersions(olderHuge, newerHuge)).toBe(-1);
    expect(compareImmutableVersions(newerHuge, olderHuge)).toBe(1);
    expect(compareImmutableVersions(olderHuge, olderHuge)).toBe(0);
    expect(compareImmutableVersions('2.9007199254740992', olderHuge)).toBe(0);
    expect(
      decideRollingMajorAlias({
        candidateVersion: olderHuge,
        immutableVersionsAtAlias: [newerHuge]
      })
    ).toEqual({ action: 'skip', reason: 'newer', version: newerHuge });
    expect(
      decideRollingMajorAlias({
        candidateVersion: newerHuge,
        immutableVersionsAtAlias: [olderHuge]
      })
    ).toEqual({ action: 'advance', reason: 'same-or-older' });
  });
});

const CANDIDATE_COMMIT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ALIAS_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MUTE_LOGGER = { log() {}, error() {}, warn() {}, info() {} };

type FakeGitOptions = {
  aliasCommit?: string | null;
  forEachRefStdout?: string;
  /** git ls-remote --exit-code status; default 2 when absent, 0 when present. */
  lsRemoteStatus?: number;
  lsRemoteStderr?: string;
  fetchAliasStatus?: number;
  fetchImmutableStatus?: number;
};

function createFakeGit(options: FakeGitOptions = {}) {
  const calls: string[][] = [];
  const aliasCommit = options.aliasCommit === undefined ? null : options.aliasCommit;
  const forEachRefStdout = options.forEachRefStdout ?? '';
  const lsRemoteStatus = options.lsRemoteStatus ?? (aliasCommit === null ? 2 : 0);
  const fetchAliasStatus = options.fetchAliasStatus ?? 0;
  const fetchImmutableStatus = options.fetchImmutableStatus ?? 0;

  const failOrReturn = (
    key: string,
    result: { status: number; stdout: string; stderr: string; error: null },
    allowFailure: boolean
  ) => {
    if (result.status !== 0 && !allowFailure) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
      throw new Error(`git ${key} failed${detail ? `: ${detail}` : ''}`);
    }
    return result;
  };

  const runGit = (args: string[], { allowFailure = false } = {}) => {
    calls.push([...args]);
    const key = args.join(' ');

    if (
      args[0] === 'ls-remote' &&
      args[1] === '--exit-code' &&
      args[2] === '--refs' &&
      args[3] === 'origin' &&
      args[4] === 'refs/tags/v2'
    ) {
      const stderr =
        options.lsRemoteStderr ??
        (lsRemoteStatus !== 0 && lsRemoteStatus !== 2 ? 'fatal: authentication failed\n' : '');
      return failOrReturn(
        key,
        {
          status: lsRemoteStatus,
          stdout: lsRemoteStatus === 0 ? `${ALIAS_COMMIT}\trefs/tags/v2\n` : '',
          stderr,
          error: null
        },
        allowFailure
      );
    }

    if (args[0] === 'fetch') {
      const isAlias =
        args.includes('--no-tags') &&
        args.includes('--depth=1') &&
        args.includes('origin') &&
        args.includes('refs/tags/v2:refs/tags/v2');
      const isImmutable =
        args.includes('--no-tags') &&
        args.includes('--depth=1') &&
        args.includes('origin') &&
        args.includes('refs/tags/v2.*:refs/tags/v2.*');
      if (!isAlias && !isImmutable) {
        throw new Error(`unexpected git invocation: ${key}`);
      }
      const status = isAlias ? fetchAliasStatus : fetchImmutableStatus;
      return failOrReturn(
        key,
        {
          status,
          stdout: '',
          stderr: status !== 0 ? 'fatal: could not fetch ref\n' : '',
          error: null
        },
        allowFailure
      );
    }
    if (key === 'rev-parse -q --verify refs/tags/v2') {
      if (aliasCommit === null) {
        return { status: 1, stdout: '', stderr: '', error: null };
      }
      return { status: 0, stdout: `${aliasCommit}\n`, stderr: '', error: null };
    }
    if (key === 'rev-parse v2^{commit}') {
      if (aliasCommit === null) {
        if (allowFailure) return { status: 1, stdout: '', stderr: '', error: null };
        throw new Error(`git ${key} failed`);
      }
      return { status: 0, stdout: `${aliasCommit}\n`, stderr: '', error: null };
    }
    if (args[0] === 'for-each-ref') {
      if (!args.includes('refs/tags/v2.*')) {
        throw new Error(`unexpected for-each-ref pattern: ${key}`);
      }
      return { status: 0, stdout: forEachRefStdout, stderr: '', error: null };
    }
    if (args[0] === 'config' || args[0] === 'tag' || args[0] === 'push') {
      return { status: 0, stdout: '', stderr: '', error: null };
    }
    throw new Error(`unexpected git invocation: ${key}`);
  };

  return { runGit, calls };
}

function assertNoMutation(calls: string[][]): void {
  expect(calls.some((args) => args[0] === 'config')).toBe(false);
  expect(calls.some((args) => args[0] === 'tag')).toBe(false);
  expect(calls.some((args) => args[0] === 'push')).toBe(false);
}

function assertScopedFetchesBeforePush(calls: string[][]): void {
  const lsRemoteIdx = calls.findIndex(
    (args) =>
      args[0] === 'ls-remote' &&
      args.includes('--exit-code') &&
      args.includes('--refs') &&
      args.includes('refs/tags/v2')
  );
  const fetchAlias = calls.findIndex(
    (args) =>
      args[0] === 'fetch' &&
      args.includes('--no-tags') &&
      args.includes('--depth=1') &&
      args.includes('refs/tags/v2:refs/tags/v2')
  );
  const fetchImmutable = calls.findIndex(
    (args) =>
      args[0] === 'fetch' &&
      args.includes('--no-tags') &&
      args.includes('--depth=1') &&
      args.includes('refs/tags/v2.*:refs/tags/v2.*')
  );
  const pushIdx = calls.findIndex((args) => args[0] === 'push');
  expect(lsRemoteIdx).toBeGreaterThanOrEqual(0);
  expect(fetchAlias).toBeGreaterThanOrEqual(0);
  expect(fetchImmutable).toBeGreaterThanOrEqual(0);
  expect(lsRemoteIdx).toBeLessThan(fetchAlias);
  expect(fetchAlias).toBeLessThan(fetchImmutable);
  const fetches = calls.filter((args) => args[0] === 'fetch');
  expect(fetches).toHaveLength(2);
  for (const fetchArgs of fetches) {
    expect(fetchArgs).toEqual(
      expect.arrayContaining(['fetch', '--no-tags', '--depth=1', 'origin'])
    );
  }
  if (pushIdx >= 0) {
    expect(fetchImmutable).toBeLessThan(pushIdx);
    // Planning (rev-parse / for-each-ref) must complete before any push.
    const planIdx = calls.findIndex((args) => args[0] === 'rev-parse' || args[0] === 'for-each-ref');
    expect(planIdx).toBeGreaterThanOrEqual(0);
    expect(planIdx).toBeLessThan(pushIdx);
  }
}

function assertOnlyMajorAliasForcePushed(calls: string[][]): void {
  const pushes = calls.filter((args) => args[0] === 'push');
  expect(pushes).toEqual([['push', 'origin', 'refs/tags/v2', '--force']]);
  const tags = calls.filter((args) => args[0] === 'tag');
  for (const tagArgs of tags) {
    expect(tagArgs).toContain('v2');
    expect(tagArgs).not.toContain('v2.1.4');
    expect(tagArgs).not.toContain('v2.0.1');
    expect(tagArgs).not.toContain('v2.1.9');
  }
  for (const pushArgs of pushes) {
    expect(pushArgs).not.toContain('refs/tags/v2.1.4');
    expect(pushArgs).not.toContain('refs/tags/v2.0.1');
    expect(pushArgs).not.toContain('refs/tags/v2.1.9');
  }
}

describe('runMajorAliasAdvance orchestration', () => {
  const priorExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = priorExitCode;
  });

  it('advances when ls-remote reports the major alias absent (status 2) without comparison fetches', () => {
    const { runGit, calls } = createFakeGit({ aliasCommit: null, lsRemoteStatus: 2 });
    const plan = runMajorAliasAdvance({
      candidateTag: 'v2.1.4',
      candidateCommit: CANDIDATE_COMMIT,
      runGit,
      logger: MUTE_LOGGER
    });
    expect(plan).toMatchObject({ action: 'advance', reason: 'absent', majorAlias: 'v2' });
    expect(calls[0]).toEqual(['ls-remote', '--exit-code', '--refs', 'origin', 'refs/tags/v2']);
    expect(calls.some((args) => args[0] === 'fetch')).toBe(false);
    expect(calls.some((args) => args[0] === 'config')).toBe(true);
    expect(calls.some((args) => args[0] === 'tag' && args.includes('-fa') && args.includes('v2'))).toBe(true);
    assertOnlyMajorAliasForcePushed(calls);
    expect(process.exitCode).toBe(priorExitCode);
  });

  it.each([
    [1, 'fatal: remote error'],
    [128, 'fatal: authentication failed']
  ] as const)(
    'throws with no config/tag/push when ls-remote fails with status %s (transport/auth)',
    (status, stderr) => {
      const { runGit, calls } = createFakeGit({
        aliasCommit: null,
        lsRemoteStatus: status,
        lsRemoteStderr: `${stderr}\n`
      });
      expect(() =>
        runMajorAliasAdvance({
          candidateTag: 'v2.1.4',
          candidateCommit: CANDIDATE_COMMIT,
          runGit,
          logger: MUTE_LOGGER
        })
      ).toThrow(/ls-remote|authentication failed|remote error|status 1|status 128/i);
      assertNoMutation(calls);
      expect(calls.some((args) => args[0] === 'fetch')).toBe(false);
      expect(process.exitCode).toBe(priorExitCode);
    }
  );

  it('throws with no mutation when the exact-alias fetch fails after ls-remote reports present', () => {
    const { runGit, calls } = createFakeGit({
      aliasCommit: ALIAS_COMMIT,
      fetchAliasStatus: 1,
      forEachRefStdout: `commit\tv2\t${ALIAS_COMMIT}\t`
    });
    expect(() =>
      runMajorAliasAdvance({
        candidateTag: 'v2.1.4',
        candidateCommit: CANDIDATE_COMMIT,
        runGit,
        logger: MUTE_LOGGER
      })
    ).toThrow(/fetch|could not fetch/i);
    assertNoMutation(calls);
    expect(calls.some((args) => args[0] === 'ls-remote')).toBe(true);
    expect(process.exitCode).toBe(priorExitCode);
  });

  it('throws with no mutation when the immutable-ref fetch fails after the alias fetch succeeds', () => {
    const { runGit, calls } = createFakeGit({
      aliasCommit: ALIAS_COMMIT,
      fetchImmutableStatus: 128,
      forEachRefStdout: `commit\tv2\t${ALIAS_COMMIT}\t`
    });
    expect(() =>
      runMajorAliasAdvance({
        candidateTag: 'v2.1.4',
        candidateCommit: CANDIDATE_COMMIT,
        runGit,
        logger: MUTE_LOGGER
      })
    ).toThrow(/fetch|could not fetch/i);
    assertNoMutation(calls);
    expect(
      calls.some(
        (args) => args[0] === 'fetch' && args.includes('refs/tags/v2:refs/tags/v2')
      )
    ).toBe(true);
    expect(process.exitCode).toBe(priorExitCode);
  });

  it('advances when the alias is tied to an older lightweight immutable version', () => {
    const forEachRefStdout = [
      `commit\tv2\t${ALIAS_COMMIT}\t`,
      `commit\tv2.0.1\t${ALIAS_COMMIT}\t`,
      `commit\tv2.1.4\t${CANDIDATE_COMMIT}\t`
    ].join('\n');
    const { runGit, calls } = createFakeGit({ aliasCommit: ALIAS_COMMIT, forEachRefStdout });
    const plan = runMajorAliasAdvance({
      candidateTag: 'v2.1.4',
      candidateCommit: CANDIDATE_COMMIT,
      runGit,
      logger: MUTE_LOGGER
    });
    expect(plan).toMatchObject({ action: 'advance', reason: 'same-or-older', majorAlias: 'v2' });
    expect(plan.immutableVersionsAtAlias).toEqual(['2.0.1']);
    expect(plan.records).toEqual(
      expect.arrayContaining([{ name: 'v2.0.1', commit: ALIAS_COMMIT, type: 'lightweight' }])
    );
    assertScopedFetchesBeforePush(calls);
    assertOnlyMajorAliasForcePushed(calls);
    expect(process.exitCode).toBe(priorExitCode);
  });

  it('advances when the alias is tied to the same annotated immutable version', () => {
    const tagObject = 'cccccccccccccccccccccccccccccccccccccccc';
    const forEachRefStdout = [
      `tag\tv2\t${tagObject}\t${ALIAS_COMMIT}`,
      `tag\tv2.1.4\t${tagObject}\t${ALIAS_COMMIT}`
    ].join('\n');
    const { runGit, calls } = createFakeGit({ aliasCommit: ALIAS_COMMIT, forEachRefStdout });
    const plan = runMajorAliasAdvance({
      candidateTag: 'v2.1.4',
      candidateCommit: CANDIDATE_COMMIT,
      runGit,
      logger: MUTE_LOGGER
    });
    expect(plan).toMatchObject({ action: 'advance', reason: 'same-or-older', majorAlias: 'v2' });
    expect(plan.immutableVersionsAtAlias).toEqual(['2.1.4']);
    expect(plan.records).toEqual(
      expect.arrayContaining([{ name: 'v2.1.4', commit: ALIAS_COMMIT, type: 'annotated' }])
    );
    assertScopedFetchesBeforePush(calls);
    assertOnlyMajorAliasForcePushed(calls);
    expect(process.exitCode).toBe(priorExitCode);
  });

  it('skips with no config/tag/push when a newer annotated immutable version is already at the alias', () => {
    const tagObject = 'cccccccccccccccccccccccccccccccccccccccc';
    const forEachRefStdout = [
      `tag\tv2\t${tagObject}\t${ALIAS_COMMIT}`,
      `tag\tv2.1.9\t${tagObject}\t${ALIAS_COMMIT}`
    ].join('\n');
    const { runGit, calls } = createFakeGit({ aliasCommit: ALIAS_COMMIT, forEachRefStdout });
    const plan = runMajorAliasAdvance({
      candidateTag: 'v2.1.4',
      candidateCommit: CANDIDATE_COMMIT,
      runGit,
      logger: MUTE_LOGGER
    });
    expect(plan).toMatchObject({ action: 'skip', reason: 'newer', version: '2.1.9', majorAlias: 'v2' });
    expect(calls.some((args) => args[0] === 'config')).toBe(false);
    expect(calls.some((args) => args[0] === 'tag')).toBe(false);
    expect(calls.some((args) => args[0] === 'push')).toBe(false);
    assertScopedFetchesBeforePush(calls);
    expect(process.exitCode).toBe(priorExitCode);
  });

  it('throws without push when the existing alias is untied to an immutable version', () => {
    const forEachRefStdout = [`commit\tv2\t${ALIAS_COMMIT}\t`].join('\n');
    const { runGit, calls } = createFakeGit({ aliasCommit: ALIAS_COMMIT, forEachRefStdout });
    expect(() =>
      runMajorAliasAdvance({
        candidateTag: 'v2.1.4',
        candidateCommit: CANDIDATE_COMMIT,
        runGit,
        logger: MUTE_LOGGER
      })
    ).toThrow(/cannot be tied to an immutable version|refusing to move/i);
    expect(calls.some((args) => args[0] === 'push')).toBe(false);
    expect(calls.some((args) => args[0] === 'tag')).toBe(false);
    expect(calls.some((args) => args[0] === 'config')).toBe(false);
    assertScopedFetchesBeforePush(calls);
    expect(process.exitCode).toBe(priorExitCode);
  });

  it('parses mixed annotated and lightweight for-each-ref records before deciding', () => {
    const tagObject = 'dddddddddddddddddddddddddddddddddddddddd';
    const forEachRefStdout = [
      `commit\tv2.0.1\t${ALIAS_COMMIT}\t`,
      `tag\tv2.1.0\t${tagObject}\t${ALIAS_COMMIT}`,
      `commit\tv2.9.9\t${CANDIDATE_COMMIT}\t`
    ].join('\n');
    const { runGit, calls } = createFakeGit({ aliasCommit: ALIAS_COMMIT, forEachRefStdout });
    const plan = runMajorAliasAdvance({
      candidateTag: 'v2.1.4',
      candidateCommit: CANDIDATE_COMMIT,
      runGit,
      logger: MUTE_LOGGER
    });
    expect(plan.records).toEqual([
      { name: 'v2.0.1', commit: ALIAS_COMMIT, type: 'lightweight' },
      { name: 'v2.1.0', commit: ALIAS_COMMIT, type: 'annotated' }
    ]);
    expect(plan.immutableVersionsAtAlias).toEqual(['2.0.1', '2.1.0']);
    expect(plan).toMatchObject({ action: 'advance', reason: 'same-or-older' });
    const forEachCall = calls.find((args) => args[0] === 'for-each-ref');
    expect(forEachCall).toEqual([
      'for-each-ref',
      '--format=%(objecttype)\t%(refname:short)\t%(objectname)\t%(*objectname)',
      'refs/tags/v2.*'
    ]);
    const forEachIdx = calls.findIndex((args) => args[0] === 'for-each-ref');
    const pushIdx = calls.findIndex((args) => args[0] === 'push');
    expect(forEachIdx).toBeGreaterThanOrEqual(0);
    expect(forEachIdx).toBeLessThan(pushIdx);
    assertOnlyMajorAliasForcePushed(calls);
    expect(process.exitCode).toBe(priorExitCode);
  });
});

describe('createSpawnGit local timeout and bounded spawn options', () => {
  const priorExitCode = process.exitCode;

  type FakeSpawnResult = {
    status: number | null;
    stdout: string;
    stderr: string;
    error: Error | null;
    signal: NodeJS.Signals | null;
    pid: number;
    output: [null, string, string];
  };

  afterEach(() => {
    process.exitCode = priorExitCode;
  });

  function assertBoundedSpawnOptions(options: Record<string, unknown>): void {
    expect(options).toMatchObject({
      encoding: 'utf8',
      timeout: GIT_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      maxBuffer: GIT_COMMAND_MAX_BUFFER,
      shell: false
    });
    expect(GIT_COMMAND_TIMEOUT_MS).toBe(120_000);
    expect(GIT_COMMAND_MAX_BUFFER).toBeLessThanOrEqual(16 * 1024 * 1024);
  }

  it('passes timeout, killSignal, maxBuffer, encoding, and no shell on every spawn', () => {
    const captured: Array<{ cmd: string; args: string[]; options: Record<string, unknown> }> = [];
    const runGit = createSpawnGit((cmd: string, args: string[], options: Record<string, unknown>): FakeSpawnResult => {
      captured.push({ cmd, args: [...args], options: { ...options } });
      // Absent alias (ls-remote status 2) advances without comparison fetches.
      const status = args[0] === 'ls-remote' ? 2 : 0;
      return {
        status,
        stdout: '',
        stderr: '',
        error: null,
        signal: null,
        pid: 0,
        output: [null, '', '']
      };
    });
    runMajorAliasAdvance({
      candidateTag: 'v2.1.4',
      candidateCommit: CANDIDATE_COMMIT,
      runGit,
      logger: MUTE_LOGGER
    });
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.some((call) => call.args[0] === 'ls-remote')).toBe(true);
    expect(captured.some((call) => call.args[0] === 'config')).toBe(true);
    expect(captured.some((call) => call.args[0] === 'tag')).toBe(true);
    expect(captured.some((call) => call.args[0] === 'push')).toBe(true);
    for (const call of captured) {
      expect(call.cmd).toBe('git');
      assertBoundedSpawnOptions(call.options);
    }
    expect(process.exitCode).toBe(priorExitCode);
  });

  it('throws clearly on ETIMEDOUT during ls-remote and never mutates config/tag/push', () => {
    const captured: Array<{ args: string[]; options: Record<string, unknown> }> = [];
    const runGit = createSpawnGit((_cmd: string, args: string[], options: Record<string, unknown>): FakeSpawnResult => {
      captured.push({ args: [...args], options: { ...options } });
      const error = Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' });
      return {
        status: null,
        stdout: '',
        stderr: '',
        error,
        signal: 'SIGTERM',
        pid: 0,
        output: [null, '', '']
      };
    });
    expect(() =>
      runMajorAliasAdvance({
        candidateTag: 'v2.1.4',
        candidateCommit: CANDIDATE_COMMIT,
        runGit,
        logger: MUTE_LOGGER
      })
    ).toThrow(new RegExp(`timed out after ${GIT_COMMAND_TIMEOUT_MS}ms`));
    expect(captured).toHaveLength(1);
    expect(captured[0].args[0]).toBe('ls-remote');
    assertBoundedSpawnOptions(captured[0].options);
    expect(captured.some((call) => call.args[0] === 'config')).toBe(false);
    expect(captured.some((call) => call.args[0] === 'tag')).toBe(false);
    expect(captured.some((call) => call.args[0] === 'push')).toBe(false);
    expect(captured.some((call) => call.args[0] === 'fetch')).toBe(false);
    expect(process.exitCode).toBe(priorExitCode);
  });

  it('throws clearly on ETIMEDOUT during fetch after a present probe and never mutates', () => {
    const captured: Array<{ args: string[]; options: Record<string, unknown> }> = [];
    const runGit = createSpawnGit((_cmd: string, args: string[], options: Record<string, unknown>): FakeSpawnResult => {
      captured.push({ args: [...args], options: { ...options } });
      assertBoundedSpawnOptions(options);
      if (args[0] === 'ls-remote') {
        return {
          status: 0,
          stdout: `${ALIAS_COMMIT}\trefs/tags/v2\n`,
          stderr: '',
          error: null,
          signal: null,
          pid: 0,
          output: [null, `${ALIAS_COMMIT}\trefs/tags/v2\n`, '']
        };
      }
      if (args[0] === 'fetch') {
        const error = Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' });
        return {
          status: null,
          stdout: '',
          stderr: '',
          error,
          signal: 'SIGTERM',
          pid: 0,
          output: [null, '', '']
        };
      }
      throw new Error(`unexpected git invocation after timeout path: ${args.join(' ')}`);
    });
    expect(() =>
      runMajorAliasAdvance({
        candidateTag: 'v2.1.4',
        candidateCommit: CANDIDATE_COMMIT,
        runGit,
        logger: MUTE_LOGGER
      })
    ).toThrow(new RegExp(`timed out after ${GIT_COMMAND_TIMEOUT_MS}ms`));
    expect(captured.some((call) => call.args[0] === 'ls-remote')).toBe(true);
    expect(captured.some((call) => call.args[0] === 'fetch')).toBe(true);
    expect(captured.some((call) => call.args[0] === 'config')).toBe(false);
    expect(captured.some((call) => call.args[0] === 'tag')).toBe(false);
    expect(captured.some((call) => call.args[0] === 'push')).toBe(false);
    expect(process.exitCode).toBe(priorExitCode);
  });

  it('throws clearly on null status without error and never mutates', () => {
    const captured: Array<{ args: string[] }> = [];
    const runGit = createSpawnGit((_cmd: string, args: string[], options: Record<string, unknown>): FakeSpawnResult => {
      captured.push({ args: [...args] });
      assertBoundedSpawnOptions(options);
      return {
        status: null,
        stdout: '',
        stderr: '',
        error: null,
        signal: 'SIGKILL',
        pid: 0,
        output: [null, '', '']
      };
    });
    expect(() =>
      runMajorAliasAdvance({
        candidateTag: 'v2.1.4',
        candidateCommit: CANDIDATE_COMMIT,
        runGit,
        logger: MUTE_LOGGER
      })
    ).toThrow(/terminated without exit status.*SIGKILL/i);
    expect(captured).toHaveLength(1);
    expect(captured[0].args[0]).toBe('ls-remote');
    expect(captured.some((call) => call.args[0] === 'config')).toBe(false);
    expect(captured.some((call) => call.args[0] === 'tag')).toBe(false);
    expect(captured.some((call) => call.args[0] === 'push')).toBe(false);
    expect(process.exitCode).toBe(priorExitCode);
  });
});

describe('release workflow artifact contract surface', () => {
  it('wires trusted digests, exact artifact allowlist/name, and npm E404 branching', () => {
    expect(releaseWorkflow).toContain('release_tgz_sha256');
    expect(releaseWorkflow).toContain('release_manifest_sha256');
    expect(releaseWorkflow).toContain('EXPECTED_RELEASE_TGZ_SHA256');
    expect(releaseWorkflow).toContain('EXPECTED_RELEASE_MANIFEST_SHA256');
    expect(releaseWorkflow).toContain('name: release-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(releaseWorkflow).toContain('isExplicitNpmE404');
    expect(releaseWorkflow).toContain('verifySha512Sri');
    expect(releaseWorkflow).toContain('node scripts/advance-release-alias.mjs');
    expect(releaseWorkflow.indexOf('Authenticate transferred release bytes')).toBeLessThan(
      releaseWorkflow.indexOf('tar -xOf release/release.tgz')
    );
  });
});
