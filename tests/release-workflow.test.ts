import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8').replace(/\r\n/g, '\n');

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

    for (const job of ['verify-package', 'publish', 'advance-major-alias'] as const) {
      expect(releaseWorkflow).toContain(
        job === 'verify-package'
          ? "if: needs.classify-release.outputs.release_kind == 'immutable'"
          : "if: needs.classify-release.outputs.release_kind == 'immutable'"
      );
    }
    expect(releaseWorkflow.match(/needs\.classify-release\.outputs\.release_kind == 'immutable'/g) ?? []).toHaveLength(3);
  });

  it('keeps validation unprivileged and publishing artifact-only with trusted hash auth before tar/verifier', () => {
    const verify = section('  verify-package:', '  publish:');
    const publish = section('  publish:', '  advance-major-alias:');

    expect(verify).toMatch(/permissions:\n {6}contents: read/);
    expect(verify).not.toContain('NPM_TOKEN');
    expect(verify).toContain('release_tgz_sha256');
    expect(verify).toContain('release_manifest_sha256');
    expect(verify).toContain('Record trusted artifact digests');
    expect(verify).toContain('name: release-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(verify).toContain('release.tgz');
    expect(verify).toContain('release-manifest.json');
    expect(verify).not.toContain('postman-insights');
    expect(verify).not.toContain('linux-x64');

    expect(publish).toMatch(/permissions:\n {6}contents: write\n {6}id-token: write/);
    expect(publish).toContain('actions/download-artifact@v7');
    expect(publish).toContain('EXPECTED_RELEASE_TGZ_SHA256');
    expect(publish).toContain('EXPECTED_RELEASE_MANIFEST_SHA256');
    expect(publish).toContain('Authenticate transferred release bytes');
    expect(publish).not.toContain('actions/checkout');
    expect(publish).not.toContain('npm ci');
    expect(publish).not.toContain('cache:');
    expect(publish).not.toContain('npm run bundle');
    expect(publish).not.toContain('npm test');
    expect(publish).not.toMatch(/npm pack(?:\s|$)/);
    assertTokenOrder('Authenticate transferred release bytes', 'tar -xOf release/release.tgz', publish);
    assertTokenOrder('Authenticate transferred release bytes', 'verify-release-artifacts.mjs', publish);
  });

  it('uses the pinned binary actionlint and the exact one-bundle max-two read-only gate set', () => {
    const verify = section('  verify-package:', '  publish:');
    expect(verify).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(verify).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(verify).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(verify).toContain('MAX_PARALLEL_GATES=2');
    expect(verify).toContain('run lint npm run lint');
    expect(verify).toContain('run typecheck npm run typecheck');
    expect(verify).toContain('run test npm test');
    expect(verify).toContain('run dist npm run verify:dist:assert');
    assertTokenOrder('- run: npm run bundle', 'name: Run gates', verify);
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
    expect(aliasScript).toContain("spawnSync('git'");
    expect(aliasScript).toContain('refs/tags/${majorAlias}:refs/tags/${majorAlias}');
    expect(aliasScript).toContain('refs/tags/${majorAlias}.*:refs/tags/${majorAlias}.*');
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
