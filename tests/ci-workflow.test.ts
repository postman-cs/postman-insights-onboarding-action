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
const windows = jobText(ciWorkflow, 'windows');

describe('CI workflow contract', () => {
  it('supersedes only older pull-request runs', () => {
    expect(ciWorkflow).toContain('group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}');
    expect(ciWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });

  it('retains Linux and Windows jobs with one install and one pre-queue bundle each', () => {
    expect(linux).toMatch(/^ {2}gate:\n/);
    expect(linux).toContain('runs-on: ubuntu-latest');
    expect(windows).toMatch(/^ {2}windows:\n/);
    expect(windows).toContain('name: Windows gate');
    expect(windows).toContain('runs-on: windows-latest');

    expect(linux.match(/^\s*- run: npm ci\s*$/gm) ?? []).toHaveLength(1);
    expect(linux.match(/^\s*- run: npm run bundle\s*$/gm) ?? []).toHaveLength(1);
    expect(windows.match(/^\s*- run: npm ci\s*$/gm) ?? []).toHaveLength(1);
    expect(windows.match(/^\s*- run: npm run bundle\s*$/gm) ?? []).toHaveLength(1);

    const linuxBundle = linux.indexOf('- run: npm run bundle');
    const linuxGates = linux.indexOf('- name: Run gates');
    expect(linuxBundle).toBeGreaterThanOrEqual(0);
    expect(linuxGates).toBeGreaterThanOrEqual(0);
    expect(linuxBundle).toBeLessThan(linuxGates);

    const windowsBundle = windows.indexOf('- run: npm run bundle');
    const windowsGates = windows.indexOf('- name: Run gates');
    expect(windowsBundle).toBeGreaterThanOrEqual(0);
    expect(windowsGates).toBeGreaterThanOrEqual(0);
    expect(windowsBundle).toBeLessThan(windowsGates);

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
      'dist',
      'actionlint',
      'commitlint',
    ]);
    expect(runGates).toContain('run lint       npm run lint');
    expect(runGates).toContain('run typecheck  npm run typecheck');
    expect(runGates).toContain('run test       npm test');
    expect(runGates).toContain('run dist       npm run verify:dist:assert');
    expect(runGates).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(runGates).toContain('if [ "${{ github.event_name }}" = "pull_request" ]; then');
    expect(runGates).toContain('run commitlint npx commitlint \\');
    expect(runGates).toContain('--from "${{ github.event.pull_request.base.sha }}"');
    expect(runGates).toContain('--to "${{ github.event.pull_request.head.sha }}"');

    // Queue stays read-only: no mutating build / verify:dist inside the fan-out.
    expect(runGates).not.toContain('npm run build');
    expect(runGates).not.toMatch(/npm run verify:dist(?:\s|$|"|')/);
    expect(runGates).not.toContain('rm -rf dist');

    expect(runGates).toContain('gate:$n=pass');
    expect(runGates).toContain('gate:$n=fail');
    expect(runGates).toContain('::group::$n');
  });

  it('installs pinned actionlint 1.7.11 into $RUNNER_TEMP without Go', () => {
    const install = namedStep(linux, 'Install actionlint');
    expect(install.length).toBeGreaterThan(0);
    expect(install).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(install).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');

    expect(ciWorkflow).not.toContain('actions/setup-go');
    expect(ciWorkflow).not.toContain('go install github.com/rhysd/actionlint');
    expect(ciWorkflow).not.toMatch(/\bgo install\b/);
  });

  it('retains Windows with exactly four read-only gates after one bundle, plus failure aggregation upload', () => {
    const runGates = namedStep(windows, 'Run gates');
    expect(runGates.length).toBeGreaterThan(0);
    expect(runGates).toContain('shell: pwsh');
    expect(runGates).toContain('$MAX_PARALLEL_GATES = 2');
    expect(runGates).toContain('while ($running.Count -ge $MAX_PARALLEL_GATES)');
    expect(runGates).toContain('Start-Job');

    const windowsGateNames = [...runGates.matchAll(/@\{ Name = '([^']+)' \}/g)].map((m) => m[1]!);
    expect(windowsGateNames).toEqual(['lint', 'test', 'typecheck', 'dist']);
    expect(runGates).toContain("@{ Name = 'lint' }");
    expect(runGates).toContain("@{ Name = 'test' }");
    expect(runGates).toContain("@{ Name = 'typecheck' }");
    expect(runGates).toContain("@{ Name = 'dist' }");

    // Fixed allowlist switch — no dynamic command evaluation.
    expect(runGates).toContain("switch ($name)");
    expect(runGates).toContain("'lint' { npm run lint }");
    expect(runGates).toContain("'test' { npm test }");
    expect(runGates).toContain("'typecheck' { npm run typecheck }");
    expect(runGates).toContain("'dist' { npm run verify:dist:assert }");
    expect(runGates).toContain('default { throw "unknown gate: $name" }');
    expect(runGates).not.toContain('Invoke-Expression');
    expect(runGates).not.toContain('Command =');

    // Nonzero child must throw so Start-Job State becomes Failed (exit keeps Completed).
    expect(runGates).toContain('if ($LASTEXITCODE -ne 0) { throw "gate $name failed: $LASTEXITCODE" }');
    expect(runGates).not.toContain('exit $LASTEXITCODE');
    expect(runGates).toContain("$results[$completed.Name] = if ($completed.State -eq 'Completed') { 0 } else { 1 }");
    expect(runGates).toContain("$results[$job.Name] = if ($job.State -eq 'Completed') { 0 } else { 1 }");

    expect(runGates).not.toContain('npm run build');
    expect(runGates).not.toMatch(/npm run verify:dist(?:\s|$|"|')/);
    expect(runGates).not.toContain('actionlint');
    expect(runGates).not.toContain('commitlint');

    expect(runGates).toContain('gate:$($gate.Name)=pass');
    expect(runGates).toContain('gate:$($gate.Name)=fail');

    const upload = namedStep(windows, 'Upload expected dist on mismatch');
    expect(upload.length).toBeGreaterThan(0);
    expect(upload).toContain('if: failure()');
    expect(upload).toContain('name: expected-dist');
    expect(upload).toContain('path: dist/');
  });

  it('keeps full-history checkout on Linux for commitlint and shallow checkout on Windows', () => {
    expect(linux).toContain('fetch-depth: 0');
    // Full history is only for the Linux commitlint range; Windows must stay shallow.
    expect(windows).not.toMatch(/^\s*fetch-depth:\s*/m);
    expect(windows).not.toContain('fetch-depth: 0');
    expect(windows).not.toContain('commitlint');
  });
});
