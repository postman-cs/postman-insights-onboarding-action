import { describe, expect, it, vi } from 'vitest';

import {
  assertWritingInputs,
  createInsightsBifrostClient,
  createInsightsTokenProvider,
  validateApiKey,
  type ActionInputs,
  type Reporter
} from '../src/index.js';

const inputs = (overrides: Partial<ActionInputs> = {}): ActionInputs => ({
  projectName: 'matrix-svc', workspaceId: 'ws-matrix', environmentId: 'env-matrix',
  systemEnvironmentId: '', clusterName: '', repoUrl: '', postmanAccessToken: 'user-token',
  postmanApiKey: 'user-pmak', postmanTeamId: '', githubToken: '', credentialPreflight: 'warn',
  createApiKey: false, serviceNotFoundPolicy: 'warn', pollTimeoutSeconds: 10,
  pollIntervalSeconds: 2, postmanRegion: 'us', postmanStack: 'prod',
  postmanApiBase: 'https://api.getpostman.com', postmanBifrostBase: 'https://bifrost.example',
  postmanIapubBase: 'https://iapub.example', postmanObservabilityBase: 'https://observability.example',
  postmanObservabilityEnv: 'production', ...overrides
});

const reporter: Reporter = { info: vi.fn(), warning: vi.fn(), setSecret: vi.fn() };

describe('Insights human-user credential matrix', () => {
  it.each([
    ['missing PMAK', { postmanApiKey: '' }],
    ['missing access token', { postmanAccessToken: '' }]
  ])('%s fails before a write and never mints', (_name, overrides) => {
    expect(() => assertWritingInputs(inputs(overrides))).toThrow(
      'human-user PMAK and a human-user session access token'
    );
  });

  it('uses the supplied token for Bifrost and does not send the PMAK', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ total: 0, nextCursor: null, items: [] })));
    vi.stubGlobal('fetch', fetchFn);
    const value = inputs({ postmanTeamId: '13347347' });
    const provider = createInsightsTokenProvider(value, reporter);
    const client = createInsightsBifrostClient(value, provider, value.postmanTeamId, value.postmanApiKey);

    await client.listDiscoveredServices();

    const request = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({ 'x-access-token': 'user-token', 'x-entity-team-id': '13347347' });
    expect(request.headers).not.toHaveProperty('x-api-key');
    expect(fetchFn.mock.calls.map(([url]) => String(url))).not.toContain('https://api.getpostman.com/service-account-tokens');
    vi.unstubAllGlobals();
  });

  it('rejects a service-account-shaped PMAK before Bifrost or observability writes', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      user: { username: null, email: null, teamId: 10490519 }
    })));
    vi.stubGlobal('fetch', fetchFn);

    await expect(validateApiKey('service-pmak')).rejects.toThrow('Insights requires a human-user PMAK');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]?.[0])).toMatch(/\/me$/);
    expect(String(fetchFn.mock.calls[0]?.[0])).not.toContain('service-account-tokens');
    vi.unstubAllGlobals();
  });
});
