import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { validateCandidateDist } from '../scripts/validate-candidate-dist.js';

const roots: string[] = [];
const expectedModes = new Map([
  ['dist/action.cjs', '100644'],
  ['dist/cli.cjs', '100755'],
  ['dist/index.cjs', '100644'],
]);

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'insights-candidate-dist-'));
  roots.push(root);
  const candidateRoot = path.join(root, 'candidate');
  await mkdir(path.join(candidateRoot, 'dist'), { recursive: true });
  const paths = [...expectedModes.keys()];
  for (const relative of paths) {
    await writeFile(path.join(candidateRoot, relative), `fixture:${relative}\n`);
    await chmod(path.join(candidateRoot, relative), relative === 'dist/cli.cjs' ? 0o755 : 0o644);
  }
  const lockBytes = Buffer.from('{"lockfileVersion":3}\n');
  const artifacts = await Promise.all(paths.map(async (relative) => {
    const absolute = path.join(candidateRoot, relative);
    const bytes = await readFile(absolute);
    const fileStat = await stat(absolute);
    return {
      path: relative,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: fileStat.size,
      mode: expectedModes.get(relative),
    };
  }));
  const manifestPath = path.join(candidateRoot, 'dist-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify({
    schema_version: 1,
    repository: 'postman-cs/postman-insights-onboarding-action',
    pull_request: 123,
    head_sha: 'a'.repeat(40),
    lock_hash: createHash('sha256').update(lockBytes).digest('hex'),
    artifacts,
  })}\n`);
  return { candidateRoot, lockBytes, manifestPath };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('candidate dist validation', () => {
  it('accepts exact digest-bound bytes and rejects post-manifest mutation', async () => {
    const input = await fixture();
    const options = {
      ...input,
      expectedRepository: 'postman-cs/postman-insights-onboarding-action',
      expectedHeadSha: 'a'.repeat(40),
      expectedPullRequest: 123,
    };

    await expect(validateCandidateDist(options)).resolves.toEqual([
      'dist/action.cjs',
      'dist/cli.cjs',
      'dist/index.cjs',
    ]);

    const actionPath = path.join(input.candidateRoot, 'dist/action.cjs');
    const mutated = await readFile(actionPath);
    mutated[0] = mutated[0] === 0x66 ? 0x67 : 0x66;
    await writeFile(actionPath, mutated);
    await expect(validateCandidateDist(options)).rejects.toThrow(/digest mismatch.*dist\/action\.cjs/i);
  });

  it.skipIf(process.platform === 'win32')('rejects unexpected downloaded POSIX modes', async () => {
    const input = await fixture();
    await chmod(path.join(input.candidateRoot, 'dist/action.cjs'), 0o600);

    await expect(validateCandidateDist({
      ...input,
      expectedRepository: 'postman-cs/postman-insights-onboarding-action',
      expectedHeadSha: 'a'.repeat(40),
      expectedPullRequest: 123,
    })).rejects.toThrow(/unexpected downloaded mode 600.*dist\/action\.cjs/i);
  });
});
