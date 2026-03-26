import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleReporter, normalizeCliFlag, parseCliArgs, toDotenv } from '../src/cli.js';

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
        '--postman-team-id', '14103640',
        '--github-token', 'ghp-abc',
        '--poll-timeout-seconds', '180',
        '--poll-interval-seconds', '8',
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
    expect(config.inputEnv[normalizeCliFlag('postman-team-id')]).toBe('14103640');
    expect(config.inputEnv[normalizeCliFlag('github-token')]).toBe('ghp-abc');
    expect(config.inputEnv[normalizeCliFlag('poll-timeout-seconds')]).toBe('180');
    expect(config.inputEnv[normalizeCliFlag('poll-interval-seconds')]).toBe('8');
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
