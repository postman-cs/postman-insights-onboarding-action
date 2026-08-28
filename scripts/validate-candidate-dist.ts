import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface ManifestArtifact {
  path: string;
  sha256: string;
  size: number;
  mode: string;
}

interface DistManifest {
  schema_version: number;
  repository: string;
  pull_request: number;
  head_sha: string;
  lock_hash: string;
  artifacts: ManifestArtifact[];
}

export interface CandidateDistValidationOptions {
  candidateRoot: string;
  manifestPath: string;
  expectedRepository: string;
  expectedHeadSha: string;
  expectedPullRequest: number;
  lockBytes: Uint8Array;
}

const EXPECTED_ARTIFACTS = new Map([
  ['dist/action.cjs', '100644'],
  ['dist/cli.cjs', '100755'],
  ['dist/index.cjs', '100644'],
]);
const MAX_ARTIFACT_SIZE = 15 * 1024 * 1024;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function collectFiles(directory: string, base = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    const fileStat = await lstat(absolute);
    if (fileStat.isSymbolicLink()) throw new Error(`symlink not allowed: ${relative}`);
    if (fileStat.isDirectory()) files.push(...await collectFiles(absolute, relative));
    else if (fileStat.isFile()) files.push(`dist/${relative}`);
    else throw new Error(`not a regular file: ${relative}`);
  }
  return files;
}

export async function validateCandidateDist(
  options: CandidateDistValidationOptions
): Promise<string[]> {
  if (!/^[a-f0-9]{40}$/.test(options.expectedHeadSha)) {
    throw new Error('expected head SHA must be 40 lowercase hexadecimal characters');
  }
  if (!Number.isSafeInteger(options.expectedPullRequest) || options.expectedPullRequest <= 0) {
    throw new Error('expected pull request must be a positive integer');
  }
  const manifest = JSON.parse(await readFile(options.manifestPath, 'utf8')) as DistManifest;
  if (manifest.schema_version !== 1) throw new Error('manifest schema_version must be 1');
  if (manifest.repository !== options.expectedRepository) throw new Error('manifest repository mismatch');
  if (manifest.head_sha !== options.expectedHeadSha) throw new Error('manifest head_sha mismatch');
  if (manifest.pull_request !== options.expectedPullRequest) throw new Error('manifest pull_request mismatch');
  if (manifest.lock_hash !== sha256(options.lockBytes)) throw new Error('manifest lock hash mismatch');
  if (!Array.isArray(manifest.artifacts)) throw new Error('manifest artifacts must be an array');

  const distRoot = path.join(options.candidateRoot, 'dist');
  const rootStat = await lstat(distRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('candidate dist must be a real directory');
  }
  const actualPaths = (await collectFiles(distRoot)).sort();
  const expectedPaths = [...EXPECTED_ARTIFACTS.keys()].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`candidate dist census mismatch: ${actualPaths.join(', ')}`);
  }

  const entries = new Map<string, ManifestArtifact>();
  for (const entry of manifest.artifacts) {
    if (!entry || typeof entry !== 'object' || entries.has(entry.path)) {
      throw new Error('manifest contains an invalid or duplicate artifact entry');
    }
    entries.set(entry.path, entry);
  }
  if (entries.size !== EXPECTED_ARTIFACTS.size) {
    throw new Error('manifest artifact census mismatch');
  }

  for (const relative of expectedPaths) {
    const entry = entries.get(relative);
    if (!entry) throw new Error(`manifest missing ${relative}`);
    if (entry.mode !== EXPECTED_ARTIFACTS.get(relative)) {
      throw new Error(`manifest mode mismatch for ${relative}`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`manifest digest malformed for ${relative}`);
    }
    const absolute = path.join(options.candidateRoot, relative);
    const bytes = await readFile(absolute);
    const fileStat = await stat(absolute);
    if (fileStat.size > MAX_ARTIFACT_SIZE) throw new Error(`oversized ${relative}`);
    if (fileStat.size !== entry.size) throw new Error(`size mismatch for ${relative}`);
    if (sha256(bytes) !== entry.sha256) throw new Error(`digest mismatch for ${relative}`);
    const mode = fileStat.mode & 0o777;
    if (mode !== 0o644 && !(relative === 'dist/cli.cjs' && mode === 0o755)) {
      throw new Error(`unexpected downloaded mode ${mode.toString(8)} for ${relative}`);
    }
  }
  return actualPaths;
}

async function main(): Promise<void> {
  const expectedHeadSha = String(process.env.PR_HEAD_SHA || '');
  const lockBytes = execFileSync('git', ['show', `${expectedHeadSha}:package-lock.json`]);
  await validateCandidateDist({
    candidateRoot: '/tmp/candidate',
    manifestPath: '/tmp/candidate/dist-manifest.json',
    expectedRepository: String(process.env.GITHUB_REPOSITORY || ''),
    expectedHeadSha,
    expectedPullRequest: Number(process.env.PR_NUMBER),
    lockBytes,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::candidate dist validation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
