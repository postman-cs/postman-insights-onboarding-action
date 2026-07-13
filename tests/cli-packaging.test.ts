import { execFile } from 'node:child_process';
import { access, chmod, constants, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function readCommittedCli(): Promise<string> {
  const result = await execFileAsync('git', ['show', 'HEAD:dist/cli.cjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  return result.stdout;
}

async function buildIsolatedPackage(): Promise<string> {
  const packageDir = await makeTempDir('postman-insights-onboard-package-');
  const distDir = path.join(packageDir, 'dist');
  await mkdir(distDir, { recursive: true });
  await writeFile(
    path.join(packageDir, 'package.json'),
    await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    'utf8'
  );

  const cliPath = path.join(distDir, 'cli.cjs');
  await execFileAsync(
    path.join(repoRoot, 'node_modules', '.bin', 'esbuild'),
    [
      path.join(repoRoot, 'src', 'cli.ts'),
      '--bundle',
      '--platform=node',
      '--target=node24',
      '--format=cjs',
      '--banner:js=#!/usr/bin/env node',
      `--outfile=${cliPath}`
    ],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  );
  await chmod(cliPath, 0o755);
  return packageDir;
}

describe('CLI packaging contract', () => {
  it('commits a Node shebang and executable mode on dist/cli.cjs', async () => {
    const contents = await readCommittedCli();
    expect(contents.startsWith('#!/usr/bin/env node\n')).toBe(true);

    const mode = await execFileAsync('git', ['ls-files', '--stage', 'dist/cli.cjs'], {
      cwd: repoRoot,
      encoding: 'utf8'
    });
    expect(mode.stdout).toMatch(/^100755 /);
  });

  it('packs, installs, and runs postman-insights-onboard --help/--version without side effects', async () => {
    const packDir = await makeTempDir('postman-insights-onboard-pack-');
    const prefixDir = await makeTempDir('postman-insights-onboard-prefix-');
    const packageDir = await buildIsolatedPackage();

    const packResult = await execFileAsync(
      'npm',
      ['pack', '--json', '--pack-destination', packDir],
      {
        cwd: packageDir,
        encoding: 'utf8',
        env: {
          NPM_CONFIG_CACHE: path.join(packDir, '.npm-cache'),
          NPM_CONFIG_IGNORE_SCRIPTS: 'true',
          PATH: process.env.PATH ?? ''
        },
        maxBuffer: 20 * 1024 * 1024
      }
    );
    const [packed] = JSON.parse(packResult.stdout) as Array<{
      filename: string;
      name: string;
    }>;
    expect(packed.name).toBe('@postman-cse/onboarding-insights');

    const tarballPath = path.join(packDir, packed.filename);
    await mkdir(prefixDir, { recursive: true });
    await execFileAsync('npm', ['install', '--prefix', prefixDir, '--ignore-scripts', tarballPath], {
      encoding: 'utf8',
      env: {
        NPM_CONFIG_CACHE: path.join(packDir, '.npm-cache'),
        PATH: process.env.PATH ?? ''
      },
      maxBuffer: 20 * 1024 * 1024
    });

    const binPath = path.join(
      prefixDir,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'postman-insights-onboard.cmd' : 'postman-insights-onboard'
    );

    const help = await execFileAsync(binPath, ['--help'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        INPUT_POSTMAN_API_KEY: 'should-not-be-used',
        POSTMAN_API_KEY: 'should-not-be-used',
        POSTMAN_ACCESS_TOKEN: 'should-not-be-used'
      },
      maxBuffer: 1024 * 1024
    });

    expect(help.stdout).toMatch(/Usage:\s+postman-insights-onboard/i);
    expect(help.stderr).not.toMatch(
      /permission denied|exec format|syntax error|unexpected token|"use strict"/i
    );
    expect(help.stdout).not.toMatch(/"use strict"/);

    const version = await execFileAsync(binPath, ['--version'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
      maxBuffer: 1024 * 1024
    });
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(version.stdout.trim()).toBe(packageJson.version);
  }, 60_000);

  it('runs the direct dist/cli.cjs artifact with a shebang path', async () => {
    const artifactDir = await makeTempDir('postman-insights-onboard-direct-');
    const cliPath = path.join(artifactDir, 'cli.cjs');
    await writeFile(cliPath, await readCommittedCli(), { encoding: 'utf8', mode: 0o755 });
    await access(cliPath, constants.X_OK);
    const help = await execFileAsync(cliPath, ['--help'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
      maxBuffer: 1024 * 1024
    });
    expect(help.stdout).toMatch(/Usage:\s+postman-insights-onboard/i);
  }, 20_000);
});
