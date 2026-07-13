import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleReporter, normalizeCliFlag, parseCliArgs, runCli, toDotenv } from '../src/cli.js';
import { getInput } from '../src/lib/input.js';
import { __resetIdentityMemo } from '../src/lib/credential-identity.js';

// Spy on the telemetry completion seam so the preflight-throw path can be
// asserted to still emit exactly one 'failure' event (regression: the credential
// preflight used to throw before the telemetry try/catch, dropping the completion
// event for the most operationally meaningful run -- a known-team credential
// failure). index.ts runAction shares the identical try placement.
const telemetrySpies = vi.hoisted(() => ({
  emitCompletion: vi.fn(),
  setTeamId: vi.fn(),
  setAccountType: vi.fn()
}));

vi.mock('@postman-cse/automation-telemetry-core', () => ({
  createTelemetryContext: vi.fn(() => ({
    setTeamId: telemetrySpies.setTeamId,
    setAccountType: telemetrySpies.setAccountType,
    emitCompletion: telemetrySpies.emitCompletion
  }))
}));

describe('parseCliArgs', () => {
  it('maps CLI flags into INPUT_* env keys', () => {
    const config = parseCliArgs(
      [
        '--project-name', 'svc-a',
        '--workspace-id=ws-123',
        '--environment-id', 'env-456',
        '--system-environment-id', 'sys-789',
        '--cluster-name', 'cluster-a',
        '--repo-url', 'https://github.com/postman-cs/repo-a',
        '--postman-access-token', 'tok-abc',
        '--postman-api-key', 'PMAK-abc',
        '--credential-preflight', 'enforce',
        '--postman-team-id', '14103640',
        '--github-token', 'ghp-abc',
        '--poll-timeout-seconds', '180',
        '--poll-interval-seconds', '8',
        '--postman-region', 'eu',
        '--postman-stack', 'beta',
        '--result-json', 'out/result.json',
        '--dotenv-path=out/result.env'
      ],
      { PATH: process.env.PATH }
    );

    expect(config.kind).toBe('run');
    if (config.kind !== 'run') {
      return;
    }
    expect(config.inputEnv[normalizeCliFlag('project-name')]).toBe('svc-a');
    expect(config.inputEnv[normalizeCliFlag('workspace-id')]).toBe('ws-123');
    expect(config.inputEnv[normalizeCliFlag('environment-id')]).toBe('env-456');
    expect(config.inputEnv[normalizeCliFlag('system-environment-id')]).toBe('sys-789');
    expect(config.inputEnv[normalizeCliFlag('cluster-name')]).toBe('cluster-a');
    expect(config.inputEnv[normalizeCliFlag('repo-url')]).toBe('https://github.com/postman-cs/repo-a');
    expect(config.inputEnv[normalizeCliFlag('postman-access-token')]).toBe('tok-abc');
    expect(config.inputEnv[normalizeCliFlag('postman-api-key')]).toBe('PMAK-abc');
    expect(config.inputEnv[normalizeCliFlag('credential-preflight')]).toBe('enforce');
    expect(config.inputEnv[normalizeCliFlag('postman-team-id')]).toBe('14103640');
    expect(config.inputEnv[normalizeCliFlag('github-token')]).toBe('ghp-abc');
    expect(config.inputEnv[normalizeCliFlag('poll-timeout-seconds')]).toBe('180');
    expect(config.inputEnv[normalizeCliFlag('poll-interval-seconds')]).toBe('8');
    expect(config.inputEnv[normalizeCliFlag('postman-region')]).toBe('eu');
    expect(config.inputEnv[normalizeCliFlag('postman-stack')]).toBe('beta');
    expect(config.resultJsonPath).toBe('out/result.json');
    expect(config.dotenvPath).toBe('out/result.env');
  });

  it('does not invent a default result-json path', () => {
    const config = parseCliArgs([], { PATH: process.env.PATH });
    expect(config.kind).toBe('run');
    if (config.kind !== 'run') {
      return;
    }
    expect(config.resultJsonPath).toBeUndefined();
  });

  it('rejects unknown flags, missing values, and unexpected positionals', () => {
    expect(() => parseCliArgs(['--not-a-real-flag', 'x'], {})).toThrow(
      /Unknown option: --not-a-real-flag/
    );
    expect(() => parseCliArgs(['--project-name'], {})).toThrow(/Missing value for --project-name/);
    expect(() => parseCliArgs(['--project-name', '--workspace-id'], {})).toThrow(
      /Missing value for --project-name/
    );
    expect(() => parseCliArgs(['--project-name='], {})).toThrow(
      /Missing value for --project-name/
    );
    expect(() => parseCliArgs(['positional-arg'], {})).toThrow(
      /Unexpected positional argument: positional-arg/
    );
  });

  it('rejects duplicate options', () => {
    expect(() => parseCliArgs(['--project-name=a', '--project-name', 'b'], {})).toThrow(
      /Duplicate option: --project-name/
    );
  });

  it('detects --help and --version without applying run options', () => {
    expect(parseCliArgs(['--help'], {}).kind).toBe('help');
    expect(parseCliArgs(['--version'], {}).kind).toBe('version');
  });

  it('lets CLI flags override env by writing the normalized INPUT key', () => {
    const config = parseCliArgs(['--project-name', 'from-cli'], {
      INPUT_PROJECT_NAME: 'from-env'
    });
    expect(config.kind).toBe('run');
    if (config.kind !== 'run') {
      return;
    }
    expect(config.inputEnv.INPUT_PROJECT_NAME).toBe('from-cli');
  });

  it('lets a CLI flag override an inherited runner-form alias', () => {
    const config = parseCliArgs(['--project-name', 'from-cli'], {
      'INPUT_PROJECT-NAME': 'from-runner'
    });
    expect(config.kind).toBe('run');
    if (config.kind !== 'run') {
      return;
    }

    expect(config.inputEnv['INPUT_PROJECT-NAME']).toBeUndefined();
    expect(getInput('project-name', config.inputEnv)).toBe('from-cli');
  });

  it('lets a CLI flag override both inherited alias forms', () => {
    const config = parseCliArgs(['--project-name=from-cli'], {
      'INPUT_PROJECT-NAME': 'from-runner',
      INPUT_PROJECT_NAME: 'from-normalized'
    });
    expect(config.kind).toBe('run');
    if (config.kind !== 'run') {
      return;
    }

    expect(config.inputEnv['INPUT_PROJECT-NAME']).toBeUndefined();
    expect(config.inputEnv.INPUT_PROJECT_NAME).toBe('from-cli');
    expect(getInput('project-name', config.inputEnv)).toBe('from-cli');
  });

  it('still rejects conflicting aliases when no CLI flag overrides them', () => {
    const config = parseCliArgs([], {
      'INPUT_PROJECT-NAME': 'from-runner',
      INPUT_PROJECT_NAME: 'from-normalized'
    });
    expect(config.kind).toBe('run');
    if (config.kind !== 'run') {
      return;
    }

    expect(() => getInput('project-name', config.inputEnv)).toThrow(
      /Conflicting values for project-name/
    );
  });
});

describe('toDotenv', () => {
  it('formats outputs with POSTMAN_INSIGHTS_ prefix', () => {
    const rendered = toDotenv({
      status: 'success',
      'collection-id': 'col-123'
    });

    expect(rendered).toContain('POSTMAN_INSIGHTS_STATUS="success"');
    expect(rendered).toContain('POSTMAN_INSIGHTS_COLLECTION_ID="col-123"');
  });
});

describe('runCli help and version', () => {
  it('prints help without credentials, network, or onboarding', async () => {
    const executeOnboarding = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    let stdout = '';

    await runCli(['--help', '--project-name', 'ignored'], {
      env: {},
      executeOnboarding,
      writeStdout: (chunk) => {
        stdout += chunk;
      }
    });

    expect(stdout).toMatch(/Usage:\s+postman-insights-onboard/i);
    expect(executeOnboarding).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('prints version without credentials, network, or onboarding', async () => {
    const executeOnboarding = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    let stdout = '';
    const packageJson = JSON.parse(
      await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
    ) as { version: string };

    await runCli(['--version'], {
      env: { INPUT_POSTMAN_API_KEY: 'should-not-matter' },
      executeOnboarding,
      writeStdout: (chunk) => {
        stdout += chunk;
      }
    });

    expect(stdout.trim()).toBe(packageJson.version);
    expect(executeOnboarding).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('runCli result-json opt-in', () => {
  beforeEach(() => {
    __resetIdentityMemo();
    telemetrySpies.emitCompletion.mockClear();
    rmSync('.vitest-tmp', { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync('.vitest-tmp', { recursive: true, force: true });
    rmSync('postman-insights-onboarding-result.json', { force: true });
  });

  function stubFetch(meTeamId: number, sessionTeamId: number) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/me')) {
        return new Response(
          JSON.stringify({ user: { id: 1, teamId: meTeamId, teamName: 'jared-demo' } }),
          { status: 200 }
        );
      }
      if (url.includes('/api/sessions/current')) {
        return new Response(
          JSON.stringify({ identity: { team: sessionTeamId, domain: 'other-org' } }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function fakeOnboarding() {
    return vi.fn(async () => ({
      discoveredServiceId: 0,
      discoveredServiceName: '',
      collectionId: '',
      applicationId: '',
      verificationToken: null,
      status: 'not-found' as const
    }));
  }

  it('does not create a result JSON file unless --result-json is provided', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(10490519, 10490519);
    const executeOnboarding = fakeOnboarding();

    await runCli(
      [
        '--project-name', 'svc',
        '--workspace-id', 'ws-1',
        '--environment-id', 'env-1',
        '--postman-access-token', 'cli-token',
        '--postman-api-key', 'PMAK-cli',
        '--postman-team-id', '10490519'
      ],
      { env: { PATH: process.env.PATH }, executeOnboarding, writeStdout: () => {} }
    );

    expect(existsSync('postman-insights-onboarding-result.json')).toBe(false);
  });

  it('writes --result-json atomically inside the workspace', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(10490519, 10490519);
    const executeOnboarding = fakeOnboarding();
    const resultPath = '.vitest-tmp/cli-result.json';

    await runCli(
      [
        '--project-name', 'svc',
        '--workspace-id', 'ws-1',
        '--environment-id', 'env-1',
        '--postman-access-token', 'cli-token',
        '--postman-api-key', 'PMAK-cli',
        '--postman-team-id', '10490519',
        '--result-json', resultPath
      ],
      { env: { PATH: process.env.PATH }, executeOnboarding, writeStdout: () => {} }
    );

    const raw = await readFile(resultPath, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ status: 'not-found' });
  });

  it('rejects --result-json paths outside the workspace', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(10490519, 10490519);
    const executeOnboarding = fakeOnboarding();

    await expect(
      runCli(
        [
          '--project-name', 'svc',
          '--workspace-id', 'ws-1',
          '--environment-id', 'env-1',
          '--postman-access-token', 'cli-token',
          '--postman-api-key', 'PMAK-cli',
          '--postman-team-id', '10490519',
          '--result-json', '../outside-result.json'
        ],
        { env: { PATH: process.env.PATH }, executeOnboarding, writeStdout: () => {} }
      )
    ).rejects.toThrow(/Output path must stay within workspace/);
    expect(executeOnboarding).not.toHaveBeenCalled();
  });

  it('rejects output paths whose parent symlink escapes the workspace', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(10490519, 10490519);
    const executeOnboarding = fakeOnboarding();
    const outside = mkdtempSync(path.join(tmpdir(), 'postman-insights-output-'));
    await mkdir('.vitest-tmp', { recursive: true });
    symlinkSync(outside, '.vitest-tmp/outside', 'dir');

    try {
      await expect(
        runCli(
          [
            '--project-name', 'svc',
            '--workspace-id', 'ws-1',
            '--environment-id', 'env-1',
            '--postman-access-token', 'cli-token',
            '--postman-api-key', 'PMAK-cli',
            '--postman-team-id', '10490519',
            '--result-json', '.vitest-tmp/outside/result.json'
          ],
          { env: { PATH: process.env.PATH }, executeOnboarding, writeStdout: () => {} }
        )
      ).rejects.toThrow(/Output path must stay within workspace/);
      expect(executeOnboarding).not.toHaveBeenCalled();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('cleans up the atomic temporary file when publication fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(10490519, 10490519);
    const executeOnboarding = fakeOnboarding();
    await mkdir('.vitest-tmp/result-directory', { recursive: true });

    await expect(
      runCli(
        [
          '--project-name', 'svc',
          '--workspace-id', 'ws-1',
          '--environment-id', 'env-1',
          '--postman-access-token', 'cli-token',
          '--postman-api-key', 'PMAK-cli',
          '--postman-team-id', '10490519',
          '--result-json', '.vitest-tmp/result-directory'
        ],
        { env: { PATH: process.env.PATH }, executeOnboarding, writeStdout: () => {} }
      )
    ).rejects.toThrow();

    expect((await readdir('.vitest-tmp')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('runCli credential preflight', () => {
  beforeEach(() => {
    __resetIdentityMemo();
    telemetrySpies.emitCompletion.mockClear();
    telemetrySpies.setTeamId.mockClear();
    telemetrySpies.setAccountType.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync('.vitest-tmp', { recursive: true, force: true });
  });

  function stubFetch(meTeamId: number, sessionTeamId: number) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/me')) {
        return new Response(
          JSON.stringify({ user: { id: 1, teamId: meTeamId, teamName: 'jared-demo' } }),
          { status: 200 }
        );
      }
      if (url.includes('/api/sessions/current')) {
        return new Response(
          JSON.stringify({ identity: { team: sessionTeamId, domain: 'other-org' } }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function fakeOnboarding() {
    return vi.fn(async () => ({
      discoveredServiceId: 0,
      discoveredServiceName: '',
      collectionId: '',
      applicationId: '',
      verificationToken: null,
      status: 'not-found' as const
    }));
  }

  it('fails fast under enforce when the credentials resolve to different parent orgs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(10490519, 13347347);
    const executeOnboarding = fakeOnboarding();

    await expect(
      runCli(
        [
          '--project-name', 'svc',
          '--workspace-id', 'ws-1',
          '--environment-id', 'env-1',
          '--postman-access-token', 'cli-enforce-token',
          '--postman-api-key', 'PMAK-cli-enforce',
          '--postman-team-id', '13347347',
          '--credential-preflight', 'enforce'
        ],
        { env: { PATH: process.env.PATH }, executeOnboarding, writeStdout: () => {} }
      )
    ).rejects.toThrow(/credential preflight FAILED/);
    expect(executeOnboarding).not.toHaveBeenCalled();
    expect(telemetrySpies.emitCompletion).toHaveBeenCalledTimes(1);
    expect(telemetrySpies.emitCompletion).toHaveBeenCalledWith('failure');
  });

  it('continues under the default warn mode and surfaces the preflight note', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(10490519, 13347347);
    const executeOnboarding = fakeOnboarding();

    await runCli(
      [
        '--project-name', 'svc',
        '--workspace-id', 'ws-1',
        '--environment-id', 'env-1',
        '--postman-access-token', 'cli-warn-token',
        '--postman-api-key', 'PMAK-cli-warn',
        '--postman-team-id', '13347347',
        '--result-json', '.vitest-tmp/cli-preflight-result.json'
      ],
      { env: { PATH: process.env.PATH }, executeOnboarding, writeStdout: () => {} }
    );

    expect(executeOnboarding).toHaveBeenCalledTimes(1);
    const lines = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes('credential preflight note'))).toBe(true);
    expect(lines.some((line) => line.includes('cli-warn-token'))).toBe(false);
  });
});

describe('ConsoleReporter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs to stderr and masks secrets', () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reporter = new ConsoleReporter();
    reporter.setSecret('secret-token');

    reporter.info('token=secret-token');
    reporter.warning('warning secret-token');

    expect(stderrSpy).toHaveBeenNthCalledWith(1, 'token=***');
    expect(stderrSpy).toHaveBeenNthCalledWith(2, 'WARNING: warning ***');
  });
});
