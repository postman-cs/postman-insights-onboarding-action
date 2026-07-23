import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8').replace(/\r\n/g, '\n');

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  if?: string;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

const parsed = parse(releaseWorkflow) as {
  jobs: Record<string, WorkflowJob | undefined>;
};

function section(startMarker: string, endMarker: string): string {
  const start = releaseWorkflow.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = releaseWorkflow.indexOf(endMarker, start + 1);
  expect(end).toBeGreaterThan(start);
  return releaseWorkflow.slice(start, end);
}

function assertTokenOrder(earlier: string, later: string, haystack = releaseWorkflow): void {
  expect(haystack).toContain(earlier);
  expect(haystack).toContain(later);
  expect(haystack.indexOf(earlier)).toBeLessThan(haystack.indexOf(later));
}

function requireJob(name: string): WorkflowJob {
  const job = parsed.jobs[name];
  expect(job, `expected job ${name} to exist in parsed release workflow`).toBeTruthy();
  return job as WorkflowJob;
}

function permissionMap(value: Record<string, string> | undefined): Record<string, string> {
  expect(value, 'permissions mapping missing').toBeTruthy();
  return value as Record<string, string>;
}

function stepRun(step: WorkflowStep | undefined): string {
  return typeof step?.run === 'string' ? step.run : '';
}

describe('release workflow publishing contract', () => {
  it('exposes classifier outputs, orders classify before install, and keeps mutations immutable-only', () => {
    expect(releaseWorkflow).toContain('classify-release');
    expect(releaseWorkflow).toContain('release_kind: ${{ steps.classify.outputs.release_kind }}');
    expect(releaseWorkflow).toContain('npm_publish: ${{ steps.classify.outputs.npm_publish }}');
    expect(releaseWorkflow).toContain("echo 'release_kind=immutable' >> \"$GITHUB_OUTPUT\"");
    expect(releaseWorkflow).toContain("echo 'npm_publish=true' >> \"$GITHUB_OUTPUT\"");
    expect(releaseWorkflow).toContain("echo 'release_kind=alias' >> \"$GITHUB_OUTPUT\"");
    expect(releaseWorkflow).toContain("echo 'npm_publish=false' >> \"$GITHUB_OUTPUT\"");
    expect(releaseWorkflow).toContain('exit 1');

    const classify = section('  classify-release:', '  verify-package:');
    expect(classify).not.toContain('npm ci');
    expect(classify).not.toContain('NPM_TOKEN');
    assertTokenOrder('name: Classify release tag', '- run: npm ci');

    const immutableGuard = "needs.classify-release.outputs.release_kind == 'immutable'";
    for (const jobName of ['verify-package', 'publish', 'advance-major-alias'] as const) {
      const job = requireJob(jobName);
      expect(job.if, `expected job ${jobName} to have an immutable if guard`).toBe(immutableGuard);
    }
    // Supplemental: exactly three global copies of the immutable expression.
    expect(releaseWorkflow.match(/needs\.classify-release\.outputs\.release_kind == 'immutable'/g) ?? []).toHaveLength(3);
  });

  it('keeps validation unprivileged and publishing artifact-only with trusted hash auth before tar/verifier', () => {
    const verifyJob = requireJob('verify-package');
    const publishJob = requireJob('publish');
    const verify = section('  verify-package:', '  publish:');
    const publish = section('  publish:', '  advance-major-alias:');

    expect(permissionMap(verifyJob.permissions)).toEqual({ contents: 'read' });
    expect(Object.keys(permissionMap(verifyJob.permissions)).sort()).toEqual(['contents']);
    expect(permissionMap(publishJob.permissions)).toEqual({
      contents: 'write',
      'id-token': 'write',
    });
    expect(Object.keys(permissionMap(publishJob.permissions)).sort()).toEqual(['contents', 'id-token']);

    expect(verify).not.toContain('NPM_TOKEN');
    expect(verify).toContain('release_tgz_sha256');
    expect(verify).toContain('release_manifest_sha256');
    expect(verify).toContain('Record trusted artifact digests');
    expect(verify).toContain('name: release-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(verify).toContain('release.tgz');
    expect(verify).toContain('release-manifest.json');
    expect(verify).not.toContain('postman-insights');
    expect(verify).not.toContain('linux-x64');

    const upload = verifyJob.steps?.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload, 'expected upload-artifact step in verify-package').toBeTruthy();
    expect(upload?.with?.name).toBe('release-${{ github.run_id }}-${{ github.run_attempt }}');
    const uploadPaths = String(upload?.with?.path ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(uploadPaths).toEqual(['release.tgz', 'release-manifest.json']);
    expect(uploadPaths).toHaveLength(2);

    expect(publish).toContain('actions/download-artifact@v7');
    expect(publish).toContain('EXPECTED_RELEASE_TGZ_SHA256');
    expect(publish).toContain('EXPECTED_RELEASE_MANIFEST_SHA256');
    expect(publish).toContain('Authenticate transferred release bytes');
    expect(publish).toContain('actions/setup-node@v7');
    expect(publish).toContain('npm view');
    expect(publish).toContain("['publish', './release/release.tgz', '--provenance', '--access', 'public']");
    expect(publish).toContain('node <<\'NODE\'');
    expect(publish).toContain('node --input-type=module <<\'NODE\'');
    expect(publish).not.toContain('actions/checkout');
    expect(publish).not.toContain('cache:');
    expect(publish).not.toMatch(/\bnpm ci\b/);
    expect(publish).not.toMatch(/\bnpm install\b/);
    expect(publish).not.toMatch(/\bnpm run\b/);
    expect(publish).not.toMatch(/\bnpm pack(?:\s|$)/);
    expect(publish).not.toContain('npm test');
    expect(publish).not.toMatch(/(?:^|[\s;|&])(?:npm\s+)?(?:build|test|lint)(?:\s|$)/m);
    expect(publish).not.toContain('typecheck');
    expect(publish).not.toContain('verify:dist');
    for (const step of publishJob.steps ?? []) {
      const run = stepRun(step);
      expect(run).not.toMatch(/\bnpm ci\b/);
      expect(run).not.toMatch(/\bnpm install\b/);
      expect(run).not.toMatch(/\bnpm run\b/);
      expect(run).not.toMatch(/\bnpm pack(?:\s|$)/);
      expect(run).not.toContain('npm test');
      expect(run).not.toMatch(/(?:^|[\s;|&])(?:npm\s+)?(?:build|test|lint)(?:\s|$)/m);
      expect(run).not.toContain('typecheck');
      expect(run).not.toContain('verify:dist');
      expect(step.uses ?? '').not.toContain('actions/checkout');
      expect(JSON.stringify(step.with ?? {})).not.toContain('cache');
    }
    assertTokenOrder('Authenticate transferred release bytes', 'tar -xOf release/release.tgz', publish);
    assertTokenOrder('Authenticate transferred release bytes', 'verify-release-artifacts.mjs', publish);
  });

  it('uses the pinned binary actionlint and the exact one-bundle max-two read-only gate set', () => {
    const verifyJob = requireJob('verify-package');
    const verify = section('  verify-package:', '  publish:');
    const verifySteps = verifyJob.steps ?? [];
    const npmCiSteps = verifySteps.filter((step) => stepRun(step).trim() === 'npm ci');
    const bundleSteps = verifySteps.filter((step) => stepRun(step).trim() === 'npm run bundle');
    expect(npmCiSteps).toHaveLength(1);
    expect(bundleSteps).toHaveLength(1);
    expect((verify.match(/^\s*- run: npm ci$/gm) ?? []).length).toBe(1);
    expect((verify.match(/^\s*- run: npm run bundle$/gm) ?? []).length).toBe(1);

    expect(verify).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(verify).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(verify).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(verify).toContain('MAX_PARALLEL_GATES=2');
    expect(verify).toContain('run lint npm run lint');
    expect(verify).toContain('run typecheck npm run typecheck');
    expect(verify).toContain('run test npm test');
    expect(verify).toContain('run dist npm run verify:dist:assert');
    assertTokenOrder('- run: npm run bundle', 'name: Run gates', verify);

    const gatesStep = verifySteps.find((step) => step.name === 'Run gates');
    expect(gatesStep, 'expected Run gates step in verify-package').toBeTruthy();
    const gateBody = stepRun(gatesStep);
    expect(gateBody).toContain('MAX_PARALLEL_GATES=2');
    expect(gateBody).not.toContain('npm run bundle');
    expect(gateBody).not.toContain('npm run build');
    expect(gateBody).not.toContain('npm pack');
    expect(gateBody).not.toContain('npm ci');
    expect(gateBody).not.toContain('npm publish');
    expect(gateBody).not.toMatch(/npm run verify:dist(?:\s|$)/);

    // Exact ordered launch set from `run <gate-name> ...` lines, excluding the helper declaration.
    const gateLaunches = gateBody
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^run\s+\S+/.test(line) && !line.startsWith('run()'))
      .map((line) => {
        const match = /^run\s+(\S+)/.exec(line);
        expect(match, `expected gate launch line: ${line}`).toBeTruthy();
        return match![1];
      });
    expect(gateLaunches).toEqual(['lint', 'typecheck', 'test', 'dist', 'actionlint']);

    expect(releaseWorkflow).not.toContain('actions/setup-go');
    expect(releaseWorkflow).not.toContain('go install github.com/rhysd/actionlint');
  });

  it('branches npm lookup on explicit E404 and publishes npm before GitHub with real ordering', () => {
    const publish = section('  publish:', '  advance-major-alias:');
    const npmPublish = "['publish', './release/release.tgz', '--provenance', '--access', 'public']";
    const npmPublishShell = 'npm publish ./release/release.tgz --provenance --access public';
    const ghRelease = 'softprops/action-gh-release';
    expect(publish).toContain("npm view \"$PKG_NAME@$PKG_VERSION\" dist.integrity");
    expect(publish).toContain('isExplicitNpmE404');
    expect(publish).toContain('verifySha512Sri');
    expect(publish).toContain('refusing to publish or mutate GitHub');
    expect(publish).toContain(npmPublish);
    expect(publish).not.toContain(npmPublishShell);
    expect(releaseWorkflow).toContain(ghRelease);
    assertTokenOrder('Publish or verify npm package identity', 'Publish GitHub release', publish);
    assertTokenOrder(npmPublish, ghRelease, releaseWorkflow);
    expect(releaseWorkflow).toContain('group: release-${{ github.repository }}');
    expect(releaseWorkflow).toContain('cancel-in-progress: false');
  });

  it('advances the rolling major alias via the semantic script with scoped fetches only', () => {
    const alias = releaseWorkflow.slice(releaseWorkflow.indexOf('  advance-major-alias:'));
    expect(alias).toMatch(/^ {2}advance-major-alias:/m);
    expect(alias).toContain('Advance rolling major alias without regression');
    expect(alias).toContain('node scripts/advance-release-alias.mjs');
    expect(alias).toContain("if: needs.classify-release.outputs.release_kind == 'immutable'");
    expect(alias).not.toContain('git fetch --tags --force');
    expect(alias).not.toContain('git merge-base --is-ancestor');
    expect(alias).not.toContain('git fetch --tags');
    expect(releaseWorkflow.match(/^ {2}advance-major-alias:/gm) ?? []).toHaveLength(1);

    const aliasScript = readFileSync(join(process.cwd(), 'scripts/advance-release-alias.mjs'), 'utf8');
    expect(aliasScript).toContain('spawnSync');
    expect(aliasScript).toContain('createSpawnGit');
    expect(aliasScript).toContain('GIT_COMMAND_TIMEOUT_MS = 120_000');
    expect(aliasScript).toContain('killSignal: \'SIGTERM\'');
    expect(aliasScript).toContain('maxBuffer: GIT_COMMAND_MAX_BUFFER');
    expect(aliasScript).toContain('shell: false');
    expect(aliasScript).toContain('refs/tags/${majorAlias}:refs/tags/${majorAlias}');
    expect(aliasScript).toContain('refs/tags/${majorAlias}.*:refs/tags/${majorAlias}.*');
    expect(aliasScript).toContain('`refs/tags/${majorAlias}.*`');
    expect(aliasScript).toContain('decideRollingMajorAlias');
    expect(aliasScript).toContain("['push', 'origin', `refs/tags/${majorAlias}`, '--force']");
    expect(aliasScript).not.toContain('merge-base');
    expect(aliasScript).toContain('--no-tags');
  });

  it('preserves Node 24, shallow verify checkout, and publish setup-node without cache', () => {
    expect(releaseWorkflow).toContain("node-version: '24'");
    const verify = section('  verify-package:', '  publish:');
    const publish = section('  publish:', '  advance-major-alias:');
    expect(verify).toContain('actions/checkout@v7');
    expect(verify).not.toContain('fetch-depth:');
    expect(publish).toContain('actions/setup-node@v7');
    expect(publish).not.toContain('cache:');
    expect(publish).not.toContain('actions/checkout');
  });
});
