import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

/** Extract one top-level job block: `  <id>:` through the next job header or EOF. */
function jobText(workflow: string, jobId: string): string {
  const jobsBody = workflow.match(/^jobs:\n([\s\S]*)$/m)?.[1] ?? '';
  const header = `  ${jobId}:\n`;
  const start = jobsBody.indexOf(header);
  if (start < 0) return '';
  const rest = jobsBody.slice(start + header.length);
  const nextJob = rest.search(/^ {2}[a-zA-Z0-9_-]+:\n/m);
  return header + (nextJob < 0 ? rest : rest.slice(0, nextJob));
}

function namedStep(source: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n?$)`));
  return match?.[0] ?? '';
}

/** Ordered gate names launched via `run <name> ...` (excludes the `run()` helper definition). */
function linuxQueuedGates(runGates: string): string[] {
  return [...runGates.matchAll(/^\s+run ([a-zA-Z0-9_-]+)\s+/gm)].map((m) => m[1]!);
}

const linux = jobText(ciWorkflow, 'gate');
const distParity = jobText(ciWorkflow, 'dist-parity');
const ready = jobText(ciWorkflow, 'ready');
const windows = jobText(ciWorkflow, 'windows');

describe('CI workflow contract', () => {
  it('supersedes only older pull-request runs', () => {
    expect(ciWorkflow).toContain('group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}');
    expect(ciWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });

  it('keeps top-level permissions and independent gate/windows jobs', () => {
    expect(ciWorkflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(linux).not.toMatch(/^\s*needs:/m);
    expect(windows).not.toMatch(/^\s*needs:/m);
    expect(distParity).toMatch(/^\s*needs:\s*gate\s*$/m);
    expect(ready).toContain('needs: [gate, dist-parity, windows]');
  });

  it('retains Linux with one install, one pre-queue bundle, and the full bounded gate set', () => {
    expect(linux).toMatch(/^ {2}gate:\n/);
    expect(linux).toContain('runs-on: ubuntu-latest');
    expect(linux).toContain('contents: read');
    expect(linux).toContain('pull-requests: read');

    expect(linux.match(/^\s*- run: npm ci\s*$/gm) ?? []).toHaveLength(1);
    expect(linux.match(/^\s*- run: npm run bundle\s*$/gm) ?? []).toHaveLength(1);

    const linuxBundle = linux.indexOf('- run: npm run bundle');
    const linuxGates = linux.indexOf('- name: Run gates');
    expect(linuxBundle).toBeGreaterThanOrEqual(0);
    expect(linuxGates).toBeGreaterThanOrEqual(0);
    expect(linuxBundle).toBeLessThan(linuxGates);

    expect(ciWorkflow).not.toMatch(/^\s*- run: npm run build\s*$/m);
  });

  it('queues the exact Linux read-only gate set with bounded PID draining and PR-only commitlint', () => {
    const runGates = namedStep(linux, 'Run gates');
    expect(runGates.length).toBeGreaterThan(0);

    expect(runGates).toContain('MAX_PARALLEL_GATES=2');
    expect(runGates).toContain('while [ "${#pid[@]}" -ge "$MAX_PARALLEL_GATES" ]; do finish_one; done');
    expect(runGates).toContain('while [ "${#pid[@]}" -gt 0 ]; do finish_one; done');
    expect(runGates).toContain('wait -n -p finished_pid');

    expect(linuxQueuedGates(runGates)).toEqual([
      'lint',
      'typecheck',
      'test',
      'dist-shape',
      'actionlint',
      'commitlint',
    ]);
    expect(runGates).toContain('run lint       npm run lint');
    expect(runGates).toContain('run typecheck  npm run typecheck');
    expect(runGates).toContain('run test       npm test');
    expect(runGates).toContain('run dist-shape npm run verify:dist:shape');
    expect(runGates).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(runGates).toContain('if [ "${{ github.event_name }}" = "pull_request" ]; then');
    expect(runGates).toContain('run commitlint npx commitlint \\');
    expect(runGates).toContain('--from "${{ github.event.pull_request.base.sha }}"');
    expect(runGates).toContain('--to "${{ github.event.pull_request.head.sha }}"');

    expect(runGates).not.toContain('npm run build');
    expect(runGates).not.toContain('verify:dist:assert');
    expect(runGates).not.toContain('verify:dist:parity');
    expect(runGates).not.toMatch(/npm run verify:dist(?:\s|$|"|')/);

    expect(runGates).toContain('gate:$n=pass');
    expect(runGates).toContain('gate:$n=fail');
    expect(runGates).toContain('::group::$n');
  });

  it('installs pinned actionlint 1.7.11 into $RUNNER_TEMP without Go', () => {
    const install = namedStep(linux, 'Install actionlint');
    expect(install.length).toBeGreaterThan(0);
    expect(install).toContain(
      'https://raw.githubusercontent.com/rhysd/actionlint/393031adb9afb225ee52ae2ccd7a5af5525e03e8/scripts/download-actionlint.bash',
    );
    expect(install.match(/393031adb9afb225ee52ae2ccd7a5af5525e03e8/)?.[0]).toHaveLength(40);
    expect(install).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(install).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(ciWorkflow).not.toContain('/main/scripts/download-actionlint.bash');

    expect(ciWorkflow).not.toContain('actions/setup-go');
    expect(ciWorkflow).not.toContain('go install github.com/rhysd/actionlint');
    expect(ciWorkflow).not.toMatch(/\bgo install\b/);
  });

  it('uses exact Windows node_modules cache pin with miss-only install and no restore keys', () => {
    expect(windows).toMatch(/^ {2}windows:\n/);
    expect(windows).toContain('name: Windows gate');
    expect(windows).toContain('runs-on: windows-latest');

    expect(windows).toContain('uses: actions/setup-node@v7');
    expect(windows).toContain("node-version: '24'");
    expect(windows).not.toMatch(/^\s*cache:\s*npm\s*$/m);

    // Semantic pin: any 40-char hex SHA, consistent across file, with semver comment
    {
      const cachePins = [...ciWorkflow.matchAll(/actions\/cache@([0-9a-f]{40})/g)].map((m) => m[1]!);
      expect(cachePins.length).toBeGreaterThanOrEqual(1);
      for (const sha of cachePins) expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(new Set(cachePins).size).toBe(1);
      expect(windows).toMatch(/uses:\s*actions\/cache@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+/);
    }
    expect(windows).toContain('id: windows-node-modules');
    expect(windows).toContain('path: node_modules');
    expect(windows).toContain("key: Windows/node-24/exact-${{ hashFiles('package-lock.json') }}");
    expect(windows).not.toContain('restore-keys');
    expect(windows).not.toContain('restore-keys:');

    expect(windows).toContain("if: steps.windows-node-modules.outputs.cache-hit != 'true'");
    expect(windows).toContain('run: npm ci --prefer-offline --no-audit --no-fund');
    expect(windows.match(/^\s*- run: npm ci(?:\s|$)/gm) ?? []).toHaveLength(0);
    expect(windows.match(/npm ci --prefer-offline --no-audit --no-fund/g) ?? []).toHaveLength(1);
  });

  it('runs unconditional direct unfiltered node --run test on Windows with no queue or ownership gates', () => {
    expect(windows.match(/^\s*- run: node --run test\s*$/gm) ?? []).toHaveLength(1);

    const cacheIdx = windows.indexOf('id: windows-node-modules');
    const missInstallIdx = windows.indexOf('npm ci --prefer-offline --no-audit --no-fund');
    const testIdx = windows.indexOf('- run: node --run test');
    expect(cacheIdx).toBeGreaterThanOrEqual(0);
    expect(missInstallIdx).toBeGreaterThan(cacheIdx);
    expect(testIdx).toBeGreaterThan(missInstallIdx);

    expect(windows).not.toContain('- name: Run gates');
    expect(windows).not.toContain('Start-Job');
    expect(windows).not.toContain('$MAX_PARALLEL_GATES');
    expect(windows).not.toContain('MAX_PARALLEL_GATES');
    expect(windows).not.toMatch(/^\s*- run: npm run bundle\s*$/m);
    expect(windows).not.toContain('npm run bundle');
    expect(windows).not.toContain('npm run build');
    expect(windows).not.toContain('npm run lint');
    expect(windows).not.toContain('npm run typecheck');
    expect(windows).not.toContain('verify:dist');
    expect(windows).not.toContain('Upload expected dist');
    expect(windows).not.toContain('expected-dist');
    expect(windows).not.toContain('actionlint');
    expect(windows).not.toContain('commitlint');
  });

  it('keeps full-history checkout on Linux for commitlint and shallow checkout on Windows', () => {
    expect(linux).toContain('fetch-depth: 0');
    expect(windows).not.toMatch(/^\s*fetch-depth:\s*/m);
    expect(windows).not.toContain('fetch-depth: 0');
    expect(windows).not.toContain('commitlint');
  });

  it('uploads candidate dist from gate and expected-dist from dist-parity on mismatch', () => {
    const candidate = namedStep(linux, 'Upload candidate dist');
    expect(candidate.length).toBeGreaterThan(0);
    expect(candidate).toContain('uses: actions/upload-artifact@v7');
    expect(candidate).toContain('name: candidate-dist');
    expect(candidate).toContain('dist/');
    expect(candidate).toContain('dist-manifest.json');
    expect(namedStep(linux, 'Write dist manifest')).toContain('lock_hash');
    expect(namedStep(linux, 'Ensure clean tracked tree outside dist')).toContain('git status --porcelain');
    expect(linux).not.toContain('name: expected-dist');

    const upload = namedStep(distParity, 'Upload expected dist on mismatch');
    expect(upload.length).toBeGreaterThan(0);
    expect(upload).toContain('if: failure()');
    expect(upload).toContain('uses: actions/upload-artifact@v7');
    expect(upload).toContain('name: expected-dist');
    expect(upload).toContain('path: dist/');
    expect(distParity).toContain('npm run verify:dist:parity');
    expect(distParity).not.toContain('verify:dist:shape');
    expect(distParity).not.toContain('verify:dist:assert');
  });

  it('aggregates gate, dist-parity, and windows in a required ready job', () => {
    expect(ready).toContain('if: always()');
    expect(ready).toContain('needs.gate.result');
    expect(ready).toContain('needs.dist-parity.result');
    expect(ready).toContain('needs.windows.result');
    expect(ready).toContain('exit 1');
  });
});
