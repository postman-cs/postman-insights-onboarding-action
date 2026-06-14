import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleReporter, normalizeCliFlag, parseCliArgs, runCli, toDotenv } from '../src/cli.js';
import { __resetIdentityMemo } from '../src/lib/credential-identity.js';

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
        '--postman-stack', 'beta',
        '--result-json', 'out/result.json',
        '--dotenv-path=out/result.env'
      ],
      { PATH: process.env.PATH }
    );

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
    expect(config.inputEnv[normalizeCliFlag('postman-stack')]).toBe('beta');
    expect(config.resultJsonPath).toBe('out/result.json');
    expect(config.dotenvPath).toBe('out/result.env');
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

describe('runCli credential preflight', () => {
  beforeEach(() => {
    __resetIdentityMemo();
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
      status: 'not-found' as const,
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
          '--credential-preflight', 'enforce',
        ],
        { env: { PATH: process.env.PATH }, executeOnboarding, writeStdout: () => {} }
      )
    ).rejects.toThrow(/credential preflight FAILED/);
    expect(executeOnboarding).not.toHaveBeenCalled();
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
        '--result-json', '.vitest-tmp/cli-preflight-result.json',
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
