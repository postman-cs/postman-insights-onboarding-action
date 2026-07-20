import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  parseCreateApiKey,
  parsePreflightMode,
  parseServiceNotFoundPolicy,
  runCredentialPreflightForInputs,
  runOnboarding,
  resolveApiKeyAndTeamId,
  resolveInputs,
  validateApiKey,
  type ActionInputs,
  type Reporter,
} from '../src/index.js';
import { REDACTED } from '../src/lib/secrets.js';
import { BifrostCatalogClient, type DiscoveredService } from '../src/lib/bifrost-client.js';
import { __resetIdentityMemo } from '../src/lib/credential-identity.js';

function createCapturingReporter(): {
  infos: string[];
  warnings: string[];
  reporter: Reporter;
} {
  const infos: string[] = [];
  const warnings: string[] = [];
  return {
    infos,
    warnings,
    reporter: {
      info: (message: string) => {
        infos.push(message);
      },
      warning: (message: string) => {
        warnings.push(message);
      },
      setSecret: () => {},
    },
  };
}

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    projectName: 'af-cards-activation',
    workspaceId: 'ws-123',
    environmentId: 'env-456',
    systemEnvironmentId: '',
    clusterName: 'se-catalog-demo',
    repoUrl: 'https://github.com/postman-cs/af-cards-activation',
    postmanAccessToken: 'tok-abc',
    postmanApiKey: 'PMAK-test',
    postmanTeamId: '14103640',
    githubToken: 'ghp_test',
    credentialPreflight: 'warn',
    createApiKey: false,
    serviceNotFoundPolicy: 'warn',
    pollTimeoutSeconds: 5,
    pollIntervalSeconds: 1,
    postmanRegion: 'us',
    postmanStack: 'prod',
    postmanApiBase: 'https://api.getpostman.com',
    postmanBifrostBase: 'https://bifrost-premium-https-v4.gw.postman.com',
    postmanIapubBase: 'https://iapub.postman.co',
    postmanObservabilityBase: 'https://api.observability.postman.com',
    postmanObservabilityEnv: 'production',
    ...overrides,
  };
}

const sampleService: DiscoveredService = {
  id: 24701,
  name: 'se-catalog-demo/af-cards-activation',
  version: null,
  sourceEnvironment: null,
  systemEnvironmentId: '8bfa188b',
  status: 'discovered',
  endpointsCount: 0,
  connectionId: 4501,
  connectionType: 'insights_project',
  tags: [],
  discoveredAt: '2026-03-09T23:47:25.000Z',
};

function makeClient(overrides: Record<string, unknown> = {}): BifrostCatalogClient {
  return {
    listDiscoveredServices: vi.fn().mockResolvedValue([sampleService]),
    prepareCollection: vi.fn().mockResolvedValue('col-abc'),
    onboardGit: vi.fn().mockResolvedValue(undefined),
    resolveProviderServiceId: vi.fn().mockResolvedValue('svc_test123'),
    acknowledgeOnboarding: vi.fn().mockResolvedValue(undefined),
    createApplication: vi.fn().mockResolvedValue({ application_id: 'app-xyz', service_id: 'svc_test123' }),
    acknowledgeWorkspace: vi.fn().mockResolvedValue(undefined),
    getTeamVerificationToken: vi.fn().mockResolvedValue('tvt_test123'),
    createApiKey: vi.fn().mockResolvedValue('PMAK-generated'),
    setApiKey: vi.fn(),
    ...overrides,
  } as unknown as BifrostCatalogClient;
}

describe('runOnboarding', () => {
  it('discovers, prepares collection, and onboards git', async () => {
    const client = makeClient();

    const result = await runOnboarding(makeInputs({ systemEnvironmentId: '8bfa188b' }), client, vi.fn());
    expect(result.status).toBe('success');
    expect(result.discoveredServiceId).toBe(24701);
    expect(result.collectionId).toBe('col-abc');
    expect(result.applicationId).toBe('app-xyz');
    expect(client.prepareCollection).toHaveBeenCalledWith(24701, 'ws-123');
    expect(client.onboardGit).toHaveBeenCalledWith({
      serviceId: 24701,
      workspaceId: 'ws-123',
      environmentId: 'env-456',
      gitRepositoryUrl: 'https://github.com/postman-cs/af-cards-activation',
      gitApiKey: 'ghp_test',
    });
    expect(client.createApplication).toHaveBeenCalledWith('ws-123', '8bfa188b', 'svc_test123');
  });

  it('returns not-found when service is not discovered within timeout', async () => {
    const client = makeClient({
      listDiscoveredServices: vi.fn().mockResolvedValue([]),
    });

    const noopSleep = vi.fn();
    const result = await runOnboarding(
      makeInputs({ pollTimeoutSeconds: 0 }),
      client,
      noopSleep,
    );
    expect(result.status).toBe('not-found');
    expect(client.prepareCollection).not.toHaveBeenCalled();
  });

  it('polls until service appears', async () => {
    let callCount = 0;
    const client = makeClient({
      listDiscoveredServices: vi.fn().mockImplementation(async () => {
        callCount++;
        return callCount >= 3 ? [sampleService] : [];
      }),
      prepareCollection: vi.fn().mockResolvedValue('col-xyz'),
      createApplication: vi.fn().mockResolvedValue({ application_id: 'app-poll', service_id: 'svc_poll' }),
      getTeamVerificationToken: vi.fn().mockResolvedValue('tvt_poll'),
    });

    const noopSleep = vi.fn();
    const result = await runOnboarding(makeInputs(), client, noopSleep);
    expect(result.status).toBe('success');
    expect(callCount).toBe(3);
    expect(noopSleep).toHaveBeenCalledTimes(2);
  });

  it('uses systemEnvironmentId from discovered service when not provided', async () => {
    const client = makeClient();

    const result = await runOnboarding(
      makeInputs({ systemEnvironmentId: '' }),
      client,
      vi.fn(),
    );
    expect(result.status).toBe('success');
    expect(client.acknowledgeOnboarding).toHaveBeenCalledWith('svc_test123', 'ws-123', '8bfa188b');
  });

  it('emits success diagnostics with concrete service/workspace/provider IDs', async () => {
    const client = makeClient();
    const { infos, warnings, reporter } = createCapturingReporter();

    const result = await runOnboarding(
      makeInputs({ systemEnvironmentId: '8bfa188b' }),
      client,
      vi.fn(),
      reporter
    );
    expect(result.status).toBe('success');
    expect(warnings).toHaveLength(0);
    expect(infos.some((entry) => entry.includes('24701') && entry.includes('ws-123'))).toBe(true);
    expect(infos.some((entry) => entry.includes('svc_test123'))).toBe(true);
    expect(infos.some((entry) => entry.includes('app-xyz'))).toBe(true);
    expect(infos.some((entry) => entry.includes('col-abc'))).toBe(true);
    expect(infos.some((entry) => entry.includes('se-catalog-demo/af-cards-activation'))).toBe(true);
    // Same one-line diagnostic helpers feed runAction success/not-found operator logs.
    expect(infos.every((entry) => !/[\r\n]/.test(entry))).toBe(true);
    expect(
      infos.some(
        (entry) =>
          entry.includes('Application binding created') &&
          entry.includes('app-xyz') &&
          entry.includes('svc_test123')
      )
    ).toBe(true);
  });

  it('emits partial-success verification-token warning with concrete workspace remediation', async () => {
    const client = makeClient({
      getTeamVerificationToken: vi.fn().mockResolvedValue(null),
    });
    const { warnings, reporter } = createCapturingReporter();

    const result = await runOnboarding(
      makeInputs({ systemEnvironmentId: '8bfa188b' }),
      client,
      vi.fn(),
      reporter
    );
    expect(result.status).toBe('success');
    expect(result.verificationToken).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/ws-123/);
    expect(warnings[0]).toMatch(/linking already completed/i);
    expect(warnings[0]).toMatch(/endpoint returned no token/i);
    expect(warnings[0]).toMatch(/Verify workspace\/team access and rerun/i);
    expect(warnings[0]).not.toMatch(/[\r\n]/);
  });

  it('emits not-found warning with concrete canonical identity and remediation', async () => {
    const client = makeClient({
      listDiscoveredServices: vi.fn().mockResolvedValue([]),
    });
    const { warnings, reporter } = createCapturingReporter();

    const result = await runOnboarding(
      makeInputs({ pollTimeoutSeconds: 0, serviceNotFoundPolicy: 'warn' }),
      client,
      vi.fn(),
      reporter
    );
    expect(result.status).toBe('not-found');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/af-cards-activation/);
    expect(warnings[0]).toMatch(/se-catalog-demo/);
    expect(warnings[0]).toMatch(/canonical "se-catalog-demo\/af-cards-activation"/);
    expect(warnings[0]).toMatch(/Verify the access token team scope/i);
    expect(warnings[0]).not.toMatch(/[\r\n]/);
    // Exercises the same one-line success/not-found context formatting helpers
    // used by runAction final operator logs (without a runAction harness).
    expect(warnings[0]).toMatch(/workspace|canonical|project|af-cards-activation/i);
  });

  it('wraps ambiguous discovered-service identity errors with workspace/canonical remediation and skips writes', async () => {
    const ambiguous: DiscoveredService[] = [
      { ...sampleService, id: 1, name: 'cluster-a/af-cards-activation' },
      { ...sampleService, id: 2, name: 'cluster-b/af-cards-activation' },
    ];
    const client = makeClient({
      listDiscoveredServices: vi.fn().mockResolvedValue(ambiguous),
    });

    let thrown: unknown;
    try {
      await runOnboarding(
        makeInputs({ clusterName: '', systemEnvironmentId: '8bfa188b' }),
        client,
        vi.fn(),
        createCapturingReporter().reporter
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error;
    expect(err.message).toMatch(/resolve discovered-service identity/i);
    expect(err.message).toMatch(/af-cards-activation/);
    expect(err.message).toMatch(/ws-123/);
    expect(err.message).toMatch(/canonical "af-cards-activation"/);
    expect(err.message).toMatch(/Provide or correct cluster-name/i);
    expect(err.message).toMatch(/Ambiguous discovered service/i);
    expect(err.message).not.toMatch(/[\r\n]/);
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toMatch(/cluster-name is required/i);
    expect(client.prepareCollection).not.toHaveBeenCalled();
    expect(client.onboardGit).not.toHaveBeenCalled();
    expect(client.resolveProviderServiceId).not.toHaveBeenCalled();
  });
});

describe('resolveApiKeyAndTeamId', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('validates existing API key and derives team ID', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { teamId: 99999 } }),
    }) as unknown as typeof fetch;

    const client = makeClient();
    const result = await resolveApiKeyAndTeamId(
      makeInputs({ postmanTeamId: '' }),
      client,
    );
    expect(result.apiKey).toBe('PMAK-test');
    expect(result.teamId).toBe('');
    expect(client.createApiKey).not.toHaveBeenCalled();
  });

  it('rejects invalid API key unless create-api-key is opted in', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const client = makeClient();
    await expect(
      resolveApiKeyAndTeamId(makeInputs({ postmanTeamId: '', createApiKey: false }), client)
    ).rejects.toThrow(/postman-api-key is invalid|create-api-key/i);
    expect(client.createApiKey).not.toHaveBeenCalled();
  });

  it('creates a durable API key only when create-api-key is opted in', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: { teamId: 13347347 } }),
      }) as unknown as typeof fetch;

    const client = makeClient();
    const result = await resolveApiKeyAndTeamId(
      makeInputs({ postmanTeamId: '', createApiKey: true, projectName: 'payments' }),
      client,
    );
    expect(result.apiKey).toBe('PMAK-generated');
    expect(client.createApiKey).toHaveBeenCalledWith('insights-onboarding-payments');
    expect(result.teamId).toBe('');
  });

  it('rejects missing API key unless create-api-key is opted in', async () => {
    const client = makeClient();
    await expect(
      resolveApiKeyAndTeamId(
        makeInputs({ postmanApiKey: '', postmanTeamId: '', createApiKey: false }),
        client,
      )
    ).rejects.toThrow(/postman-api-key is required|create-api-key/i);
    expect(client.createApiKey).not.toHaveBeenCalled();
  });

  it('does not require a derived team ID when none is provided', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: {} }),
    }) as unknown as typeof fetch;

    const client = makeClient();
    const result = await resolveApiKeyAndTeamId(
      makeInputs({ postmanTeamId: '' }),
      client,
    );
    expect(result.teamId).toBe('');
  });

  it('uses explicit postman-team-id when provided', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { teamId: 11111 } }),
    }) as unknown as typeof fetch;

    const client = makeClient();
    const { infos, reporter } = createCapturingReporter();
    const result = await resolveApiKeyAndTeamId(
      makeInputs({ postmanTeamId: '55555' }),
      client,
      reporter
    );
    expect(result.teamId).toBe('55555');
    expect(infos.some((entry) => entry.includes('55555') && !entry.includes('\n'))).toBe(true);
  });

  it('wraps createApiKey rejection with sanitized project/key name, cause, and remediation', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const cause = new Error('bifrost create failed');
    const client = makeClient({
      createApiKey: vi.fn().mockRejectedValue(cause),
    });
    const { infos, reporter } = createCapturingReporter();

    let thrown: unknown;
    try {
      await resolveApiKeyAndTeamId(
        makeInputs({
          postmanApiKey: 'PMAK-bad',
          createApiKey: true,
          projectName: 'pay\rments\napp',
          postmanTeamId: 'team\r\n-1',
        }),
        client,
        reporter
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error;
    expect(err.message).toMatch(/createApiKey/);
    expect(err.message).toMatch(/insights-onboarding-pay ments app/);
    expect(err.message).toMatch(/project "pay ments app"/);
    expect(err.message).toMatch(/bifrost create failed/);
    expect(err.message).toMatch(/Verify Bifrost identity access/i);
    expect(err.message).not.toMatch(/[\r\n]/);
    expect(err.cause).toBe(cause);
    expect(client.createApiKey).toHaveBeenCalledWith('insights-onboarding-pay\rments\napp');
    expect(infos.every((entry) => !/[\r\n]/.test(entry))).toBe(true);
  });

  it('names the created key and GET /me endpoint when post-create validation fails', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) }) as unknown as typeof fetch;

    const client = makeClient({
      createApiKey: vi.fn().mockResolvedValue('PMAK-generated'),
    });

    await expect(
      resolveApiKeyAndTeamId(
        makeInputs({ postmanApiKey: 'PMAK-bad', createApiKey: true, projectName: 'payments' }),
        client,
        createCapturingReporter().reporter
      )
    ).rejects.toThrow(/insights-onboarding-payments.*GET https:\/\/api\.getpostman\.com\/me|could not be validated via GET/i);
    expect(client.createApiKey).toHaveBeenCalledWith('insights-onboarding-payments');
  });
});

describe('validateApiKey', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns valid=true with teamId for a good key', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { teamId: 12345 } }),
    }) as unknown as typeof fetch;

    const result = await validateApiKey('PMAK-good');
    expect(result.valid).toBe(true);
    expect(result.teamId).toBe('12345');
  });

  it('defaults to prod /me when no base URL is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { teamId: 12345 } }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await validateApiKey('PMAK-good');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.getpostman.com/me');
  });

  it('routes /me through a custom api base URL when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { teamId: 12345 } }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Trailing slash should be normalized away so the path joins cleanly.
    await validateApiKey('PMAK-good', 'https://api.getpostman-beta.com/');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.getpostman-beta.com/me');
  });

  it('returns valid=false for a 401 key', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    }) as unknown as typeof fetch;

    const result = await validateApiKey('PMAK-bad');
    expect(result.valid).toBe(false);
    expect(result.teamId).toBeUndefined();
  });

  it('returns valid=false for a 403 key', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    }) as unknown as typeof fetch;

    const result = await validateApiKey('PMAK-forbidden');
    expect(result.valid).toBe(false);
  });

  it('throws on unexpected HTTP status (e.g. 500)', async () => {
    const sentinelKey = 'PMAK-sentinel-http-500-key';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await validateApiKey(sentinelKey);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error;
    expect(err.message).toMatch(/API key validation failed for GET https:\/\/api\.getpostman\.com\/me/);
    expect(err.message).toMatch(/unexpected status 500/);
    expect(err.message).toMatch(/Verify the Postman API endpoint\/network/i);
    expect(err.message).not.toContain(sentinelKey);
    expect(err.message).not.toMatch(/[\r\n]/);
  });

  it('throws on network error instead of treating as invalid', async () => {
    const sentinelKey = 'PMAK-sentinel-network-key';
    const cause = new Error(`network failed while using ${sentinelKey}`);
    globalThis.fetch = vi.fn().mockRejectedValue(cause) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await validateApiKey(sentinelKey);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error;
    expect(err.message).toMatch(/API key validation failed for GET https:\/\/api\.getpostman\.com\/me/);
    expect(err.message).toMatch(/network failed while using/);
    expect(err.message).toContain(REDACTED);
    expect(err.message).not.toContain(sentinelKey);
    expect(err.message).toMatch(/Verify the Postman API endpoint\/network/i);
    expect(err.message).not.toMatch(/[\r\n]/);
    expect(err.cause).toBe(cause);
    expect((err.cause as Error).message).toContain(sentinelKey);
  });
});

describe('getTeams', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns parsed teams from API', async () => {
    const { getTeams } = await import('../src/index.js');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 1, name: 'Team Alpha', organizationId: 100 },
          { id: 2, name: 'Team Beta', organizationId: 100 }
        ]
      }),
    }) as unknown as typeof fetch;

    const result = await getTeams('PMAK-test');
    expect(result).toEqual([
      { id: 1, name: 'Team Alpha', organizationId: 100 },
      { id: 2, name: 'Team Beta', organizationId: 100 },
    ]);
  });

  it('returns empty array on API error', async () => {
    const { getTeams } = await import('../src/index.js');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as unknown as typeof fetch;

    const result = await getTeams('PMAK-test');
    expect(result).toEqual([]);
  });

  it('returns empty array on network error', async () => {
    const { getTeams } = await import('../src/index.js');
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as unknown as typeof fetch;

    const result = await getTeams('PMAK-test');
    expect(result).toEqual([]);
  });

  it('filters out teams without id or name', async () => {
    const { getTeams } = await import('../src/index.js');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 1, name: 'Valid Team' },
          { id: null, name: 'Missing ID' },
          { id: 2, name: '' },
          { id: undefined, name: 'Undefined ID' },
        ]
      }),
    }) as unknown as typeof fetch;

    const result = await getTeams('PMAK-test');
    expect(result).toEqual([{ id: 1, name: 'Valid Team' }]);
  });
});

describe('resolveInputs env var fallbacks', () => {
  it('uses POSTMAN_WORKSPACE_ID env var when input is empty', () => {
    const env = {
      INPUT_PROJECT_NAME: 'my-project',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok-test',
      INPUT_WORKSPACE_ID: '',
      INPUT_ENVIRONMENT_ID: 'env-123',
      POSTMAN_WORKSPACE_ID: 'ws-env-fallback',
    };
    const result = resolveInputs(env);
    expect(result.workspaceId).toBe('ws-env-fallback');
  });

  it('uses POSTMAN_ENVIRONMENT_ID env var when input is empty', () => {
    const env = {
      INPUT_PROJECT_NAME: 'my-project',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok-test',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_ENVIRONMENT_ID: '',
      POSTMAN_ENVIRONMENT_ID: 'env-env-fallback',
    };
    const result = resolveInputs(env);
    expect(result.environmentId).toBe('env-env-fallback');
  });

  it('throws when both input and env var are missing for workspace-id', () => {
    const env = {
      INPUT_PROJECT_NAME: 'my-project',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok-test',
      INPUT_WORKSPACE_ID: '',
      INPUT_ENVIRONMENT_ID: 'env-123',
    };
    expect(() => resolveInputs(env)).toThrow('workspace-id is required');
  });

  it('throws when both input and env var are missing for environment-id', () => {
    const env = {
      INPUT_PROJECT_NAME: 'my-project',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok-test',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_ENVIRONMENT_ID: '',
    };
    expect(() => resolveInputs(env)).toThrow('environment-id is required');
  });
});

describe('resolveApiKeyAndTeamId never infers team from PMAK', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('leaves team id empty even when /teams returns org-mode sub-teams', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith('/me')) {
        return { ok: true, json: async () => ({ user: { teamId: 10 } }) };
      }
      if (String(url).endsWith('/teams')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 10, name: 'SubTeam A', organizationId: 999 },
              { id: 11, name: 'SubTeam B', organizationId: 999 }
            ]
          }),
        };
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    const client = makeClient();
    const result = await resolveApiKeyAndTeamId(
      makeInputs({ postmanTeamId: '' }),
      client,
    );
    expect(result.teamId).toBe('');
    const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith('/teams'))).toBe(false);
  });

  it('does not auto-pick a single org-mode sub-team from PMAK', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith('/me')) {
        return { ok: true, json: async () => ({ user: { teamId: 10 } }) };
      }
      if (String(url).endsWith('/teams')) {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: 10, name: 'Only Team', organizationId: 999 }]
          }),
        };
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    const client = makeClient();
    const result = await resolveApiKeyAndTeamId(
      makeInputs({ postmanTeamId: '' }),
      client,
    );
    expect(result.teamId).toBe('');
  });
});

describe('credential preflight seam', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    __resetIdentityMemo();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function createReporter() {
    const infos: string[] = [];
    const warnings: string[] = [];
    return {
      infos,
      warnings,
      reporter: {
        info: (message: string) => {
          infos.push(message);
        },
        warning: (message: string) => {
          warnings.push(message);
        },
        setSecret: () => {},
      },
    };
  }

  function sessionResponse(team: number) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        identity: { team, domain: 'session-domain' },
        data: { user: { id: 2, roles: ['admin'] } },
        consumerType: 'service_account',
      }),
    };
  }

  it('resolveApiKeyAndTeamId surfaces the validated /me identity for preflight reuse', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { teamId: 13347347 } }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await resolveApiKeyAndTeamId(makeInputs({ postmanTeamId: '55555' }), makeClient());
    expect(result.pmakIdentity).toEqual({ source: 'pmak/me', teamId: '13347347' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('validates an explicitly created PMAK before linking', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: { teamId: 13347347 } })
      }) as unknown as typeof fetch;
    const resolved = await resolveApiKeyAndTeamId(
      makeInputs({ postmanTeamId: '55555', createApiKey: true }),
      makeClient()
    );
    expect(resolved.apiKey).toBe('PMAK-generated');
    expect(resolved.pmakIdentity).toEqual({ source: 'pmak/me', teamId: '13347347' });

    const { infos, warnings, reporter } = createReporter();
    const preflightFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/me')) {
        throw new Error('preflight must not probe /me');
      }
      return sessionResponse(13347347);
    });

    await expect(
      runCredentialPreflightForInputs(
        makeInputs({ credentialPreflight: 'enforce', postmanAccessToken: 'seam-token-rejected' }),
        resolved.pmakIdentity,
        reporter,
        preflightFetch as unknown as typeof fetch
      )
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(0);
    expect(infos.some((entry) => entry.includes('access-token session identity'))).toBe(true);
  });

  it('reuses the pre-resolved pmak identity without a /me probe and FAILs under enforce on cross-org credentials', async () => {
    const { reporter } = createReporter();
    const preflightFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/me')) {
        throw new Error('preflight must not probe /me');
      }
      return sessionResponse(13347347);
    });

    await expect(
      runCredentialPreflightForInputs(
        makeInputs({ credentialPreflight: 'enforce', postmanAccessToken: 'seam-token-enforce' }),
        { source: 'pmak/me', teamId: '10490519' },
        reporter,
        preflightFetch as unknown as typeof fetch
      )
    ).rejects.toThrow(/credential preflight FAILED/);
    const meCalls = preflightFetch.mock.calls.filter((call) => String(call[0]).endsWith('/me'));
    expect(meCalls).toHaveLength(0);
  });

  it('logs preflight OK when both identities resolve the same parent org', async () => {
    const { infos, reporter } = createReporter();
    const preflightFetch = vi.fn(async () => sessionResponse(13347347));

    await runCredentialPreflightForInputs(
      makeInputs({ credentialPreflight: 'enforce', postmanAccessToken: 'seam-token-ok' }),
      { source: 'pmak/me', teamId: '13347347' },
      reporter,
      preflightFetch as unknown as typeof fetch
    );
    expect(infos.some((entry) => entry.includes('PMAK identity'))).toBe(true);
    expect(infos.some((entry) => entry.includes('credential preflight OK'))).toBe(true);
  });

  it('parsePreflightMode defaults to enforce, normalizes case, and rejects unknown values', () => {
    expect(parsePreflightMode(undefined)).toBe('enforce');
    expect(parsePreflightMode('')).toBe('enforce');
    expect(parsePreflightMode(' ENFORCE ')).toBe('enforce');
    expect(() => parsePreflightMode('off')).toThrow(/Unsupported credential-preflight/);
    expect(() => parsePreflightMode('strict')).toThrow(/Unsupported credential-preflight/);
  });

  it('parser invalid-value errors stay one-line with sanitized CR/LF values and remediation', () => {
    const cases: Array<{ run: () => void; option: RegExp; supported: RegExp }> = [
      {
        run: () => parsePreflightMode('off\r\nstrict'),
        option: /Unsupported credential-preflight "off strict"/,
        supported: /Supported values: enforce, warn/,
      },
      {
        run: () => parseServiceNotFoundPolicy('maybe\r\nfail'),
        option: /Unsupported service-not-found-policy "maybe fail"/,
        supported: /Supported values: fail, warn/,
      },
      {
        run: () => parseCreateApiKey('yes\r\nplease'),
        option: /Unsupported create-api-key "yes please"/,
        supported: /Supported values: true, false/,
      },
    ];

    for (const entry of cases) {
      let thrown: unknown;
      try {
        entry.run();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toMatch(entry.option);
      expect(message).toMatch(entry.supported);
      expect(message).toMatch(/Provide one of the supported values, then rerun/);
      expect(message).not.toMatch(/[\r\n]/);
    }
  });
});
