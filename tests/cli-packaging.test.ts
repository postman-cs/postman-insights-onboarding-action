import { execFile } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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

describe('CLI packaging contract', () => {
  it('commits a Node shebang and git-index executable mode on dist/cli.cjs', async () => {
    const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
    const contents = await readFile(cliPath, 'utf8');
    expect(contents.startsWith('#!/usr/bin/env node\n')).toBe(true);

    const mode = (await stat(cliPath)).mode & 0o777;
    expect(mode & 0o111).not.toBe(0);
    await access(cliPath, constants.X_OK);

    const staged = await execFileAsync('git', ['ls-files', '--stage', 'dist/cli.cjs'], {
      cwd: repoRoot,
      encoding: 'utf8'
    });
    expect(staged.stdout).toMatch(/^100755 /);
  });

  it('runs ./dist/cli.cjs --help and --version without credentials, network, or writes', async () => {
    const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const sandbox = await makeTempDir('postman-insights-onboard-cli-sandbox-');
    const env = {
      PATH: process.env.PATH ?? '',
      INPUT_POSTMAN_API_KEY: '',
      POSTMAN_API_KEY: '',
      POSTMAN_ACCESS_TOKEN: '',
      INPUT_POSTMAN_ACCESS_TOKEN: '',
      HOME: sandbox,
      TMPDIR: sandbox
    };

    const help = await execFileAsync(cliPath, ['--help'], {
      cwd: sandbox,
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024
    });
    expect(help.stdout).toMatch(/Usage:\s+postman-insights-onboard/i);
    expect(help.stderr).not.toMatch(
      /permission denied|exec format|syntax error|unexpected token|"use strict"/i
    );
    expect(help.stdout).not.toMatch(/"use strict"/);

    const version = await execFileAsync(cliPath, ['--version'], {
      cwd: sandbox,
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024
    });
    expect(version.stdout.trim()).toBe(packageJson.version);

    const written = await readdir(sandbox, { recursive: true });
    expect(written).toEqual([]);
  }, 20_000);

  it('keeps an exact dist census of action/cli/index entrypoints', async () => {
    const distDir = path.join(repoRoot, 'dist');
    const entries = (
      await execFileAsync('git', ['ls-files', '--', 'dist'], {
        cwd: repoRoot,
        encoding: 'utf8'
      })
    ).stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((filePath) => path.basename(filePath))
      .sort();
    expect(entries).toEqual(['action.cjs', 'cli.cjs', 'index.cjs']);

    const onDisk = await readdir(distDir);
    expect(onDisk.filter((name) => !name.startsWith('.')).sort()).toEqual([
      'action.cjs',
      'cli.cjs',
      'index.cjs'
    ]);
  });

  it('does not rebuild dist from packaging tests', async () => {
    const packageJson = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const packagingSource = await readFile(path.join(repoRoot, 'tests', 'cli-packaging.test.ts'), 'utf8');
    expect(packageJson).toMatch(/"verify:dist:assert"/);
    expect(packageJson).toMatch(/"bundle"/);
    expect(packagingSource).not.toMatch(/\bnpm run (?:build|bundle)\b/);
    expect(packagingSource).not.toMatch(/\besbuild\b/);
    // Split the forbidden rebuild signal so this assertion does not match itself.
    expect(packagingSource.includes(['rm', '-rf', 'dist'].join(' '))).toBe(false);
  });

  it('packs, installs, and runs postman-insights-onboard --help/--version from committed dist', async () => {
    const packDir = await makeTempDir('postman-insights-onboard-pack-');
    const prefixDir = await makeTempDir('postman-insights-onboard-prefix-');

    const packResult = await execFileAsync(
      'npm',
      ['pack', '--json', '--pack-destination', packDir],
      {
        cwd: repoRoot,
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
    await writeFile(cliPath, await readFile(path.join(repoRoot, 'dist', 'cli.cjs'), 'utf8'), {
      encoding: 'utf8',
      mode: 0o755
    });
    await access(cliPath, constants.X_OK);
    const help = await execFileAsync(cliPath, ['--help'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
      maxBuffer: 1024 * 1024
    });
    expect(help.stdout).toMatch(/Usage:\s+postman-insights-onboard/i);
  }, 20_000);
});
