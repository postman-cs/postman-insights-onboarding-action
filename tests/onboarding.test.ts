import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  runOnboarding,
  resolveApiKeyAndTeamId,
  validateApiKey,
  type ActionInputs,
} from '../src/index.js';
import { BifrostCatalogClient, type DiscoveredService } from '../src/lib/bifrost-client.js';

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    projectName: 'af-cards-activation',
    workspaceId: 'ws-123',
    environmentId: 'env-456',
    systemEnvironmentId: '',
    clusterName: 'se-catalog-demo',
    gitOwner: 'postman-cs',
    gitRepositoryName: 'af-cards-activation',
    postmanAccessToken: 'tok-abc',
    postmanApiKey: 'PMAK-test',
    postmanTeamId: '14103640',
    githubToken: 'ghp_test',
    pollTimeoutSeconds: 5,
    pollIntervalSeconds: 1,
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
    expect(client.createApplication).toHaveBeenCalledWith('ws-123', '8bfa188b');
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

  it('creates new API key when provided key is invalid', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ user: { teamId: 88888 } }) };
    }) as unknown as typeof fetch;

    const client = makeClient();
    const result = await resolveApiKeyAndTeamId(
      makeInputs({ postmanTeamId: '' }),
      client,
    );
    expect(result.apiKey).toBe('PMAK-generated');
    expect(client.createApiKey).toHaveBeenCalled();
    expect(result.teamId).toBe('');
  });

  it('creates new API key when no key is provided', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { teamId: 77777 } }),
    }) as unknown as typeof fetch;

    const client = makeClient();
    const result = await resolveApiKeyAndTeamId(
      makeInputs({ postmanApiKey: '', postmanTeamId: '' }),
      client,
    );
    expect(result.apiKey).toBe('PMAK-generated');
    expect(client.createApiKey).toHaveBeenCalled();
    expect(result.teamId).toBe('');
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
    const result = await resolveApiKeyAndTeamId(
      makeInputs({ postmanTeamId: '55555' }),
      client,
    );
    expect(result.teamId).toBe('55555');
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
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as unknown as typeof fetch;

    await expect(validateApiKey('PMAK-err')).rejects.toThrow(
      'API key validation failed with unexpected status 500'
    );
  });

  it('throws on network error instead of treating as invalid', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as unknown as typeof fetch;

    await expect(validateApiKey('PMAK-err')).rejects.toThrow('network');
  });
});
