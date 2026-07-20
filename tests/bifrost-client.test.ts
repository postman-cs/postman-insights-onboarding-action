import { describe, expect, it, vi } from 'vitest';
import { BifrostCatalogClient, findDiscoveredService, type DiscoveredService } from '../src/lib/bifrost-client.js';

function mockFetch(responses: Array<{ ok: boolean; status: number; body: unknown }>): typeof globalThis.fetch {
  let callIndex = 0;
  return vi.fn(async () => {
    const response = responses[callIndex] || responses[responses.length - 1];
    callIndex++;
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.ok ? 'OK' : 'Error',
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    } as Response;
  });
}

const sampleServices: DiscoveredService[] = [
  {
    id: 24701,
    name: 'se-catalog-demo/af-cards-activation',
    version: null,
    sourceEnvironment: null,
    systemEnvironmentId: '8bfa188b-8747-4dc8-a8ef-0f2c67677e43',
    status: 'discovered',
    endpointsCount: 0,
    connectionId: 4501,
    connectionType: 'insights_project',
    tags: [],
    discoveredAt: '2026-03-09T23:47:25.000Z',
  },
  {
    id: 24751,
    name: 'se-catalog-demo/af-cards-authorization',
    version: null,
    sourceEnvironment: null,
    systemEnvironmentId: '8bfa188b-8747-4dc8-a8ef-0f2c67677e43',
    status: 'discovered',
    endpointsCount: 0,
    connectionId: 4501,
    connectionType: 'insights_project',
    tags: [],
    discoveredAt: '2026-03-09T23:47:25.000Z',
  },
];

describe('BifrostCatalogClient', () => {
  it('lists discovered services', async () => {
    const fetchFn = mockFetch([{
      ok: true,
      status: 200,
      body: { total: 2, nextCursor: null, items: sampleServices },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });
    const services = await client.listDiscoveredServices();
    expect(services).toHaveLength(2);
    expect(services[0].name).toBe('se-catalog-demo/af-cards-activation');
  });

  it('prepares a collection', async () => {
    const fetchFn = mockFetch([{
      ok: true,
      status: 200,
      body: { id: 'col-abc-123' },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });
    const id = await client.prepareCollection(24701, 'ws-123');
    expect(id).toBe('col-abc-123');
  });

  it('onboards git integration', async () => {
    const fetchFn = mockFetch([{
      ok: true,
      status: 200,
      body: { message: 'Successfully integrated the service with postman' },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });
    await expect(client.onboardGit({
      serviceId: 24701,
      workspaceId: 'ws-123',
      environmentId: 'env-456',
      gitRepositoryUrl: 'https://github.com/postman-cs/af-cards-activation',
      gitApiKey: 'ghp_test',
    })).resolves.toBeUndefined();

    const mutationCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.find((call) => {
      const body = JSON.parse(call[1].body);
      return body.method === 'POST' && String(body.path).includes('/onboarding/git');
    });
    expect(mutationCall).toBeTruthy();
    const callBody = JSON.parse(mutationCall![1].body);
    expect(callBody.body.via_integrations).toBe(false);
    expect(callBody.body.service_id).toBe(24701);
    expect(callBody.body.git_api_key).toBe('ghp_test');
  });

  it('omits git_api_key when not provided', async () => {
    const fetchFn = mockFetch([{
      ok: true,
      status: 200,
      body: { message: 'ok' },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });
    await client.onboardGit({
      serviceId: 24701,
      workspaceId: 'ws-123',
      environmentId: 'env-456',
      gitRepositoryUrl: 'https://github.com/postman-cs/af-cards-activation',
    });

    const mutationCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.find((call) => {
      const body = JSON.parse(call[1].body);
      return body.method === 'POST' && String(body.path).includes('/onboarding/git');
    });
    expect(mutationCall).toBeTruthy();
    const callBody = JSON.parse(mutationCall![1].body);
    expect(callBody.body.git_api_key).toBeUndefined();
    expect(callBody.body.via_integrations).toBe(false);
  });

  it('throws an advised 403 error on mutation without retrying ordinary 4xx', async () => {
    const fetchFn = mockFetch([
      { ok: true, status: 200, body: { total: 0, nextCursor: null, items: [] } },
      { ok: false, status: 403, body: { error: 'forbidden' } },
    ]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });
    await expect(client.onboardGit({
      serviceId: 999,
      workspaceId: 'ws-x',
      environmentId: 'env-x',
      gitRepositoryUrl: 'https://github.com/org/repo',
      gitApiKey: 'ghp_test',
    })).rejects.toThrow(/refused git onboarding.*with 403/);
    const mutationPosts = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter((call) => {
      const body = JSON.parse(call[1].body);
      return body.method === 'POST' && String(body.path).includes('/onboarding/git');
    });
    expect(mutationPosts).toHaveLength(1);
  }, 15_000);

  it('redacts an echoed github token from failed git onboarding while keeping entity context', async () => {
    const gitApiKey = 'ghp_echoed_secret_token_for_redaction';
    const fetchFn = mockFetch([
      { ok: true, status: 200, body: { total: 0, nextCursor: null, items: [] } },
      {
        ok: false,
        status: 403,
        body: { error: `forbidden; received key ${gitApiKey}` },
      },
    ]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });
    try {
      await client.onboardGit({
        serviceId: 24701,
        workspaceId: 'ws-123',
        environmentId: 'env-456',
        gitRepositoryUrl: 'https://github.com/postman-cs/af-cards-activation',
        gitApiKey,
      });
      expect.fail('expected onboardGit to throw');
    } catch (err) {
      const error = err as Error;
      const causeMessage = error.cause instanceof Error ? error.cause.message : '';
      const combined = `${error.message}\n${causeMessage}`;
      expect(combined).not.toContain(gitApiKey);
      expect(error.message).toContain('https://github.com/postman-cs/af-cards-activation');
      expect(error.message).toContain('24701');
      expect(error.message).toContain('ws-123');
      expect(error.message).toContain('env-456');
    }
    const mutationPosts = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter((call) => {
      const body = JSON.parse(call[1].body);
      return body.method === 'POST' && String(body.path).includes('/onboarding/git');
    });
    expect(mutationPosts).toHaveLength(1);
  }, 15_000);

  it('redacts access token and PMAK from unknown Akita acknowledge errors while keeping operation IDs', async () => {
    const accessToken = 'tok-akita-secret-abc';
    const apiKey = 'PMAK-akita-secret-xyz';
    const fetchFn = mockFetch([
      { ok: true, status: 200, body: { services: [] } },
      {
        ok: false,
        status: 403,
        body: { error: `denied token=${accessToken} key=${apiKey}` },
      },
    ]);
    const client = new BifrostCatalogClient({
      accessToken,
      teamId: '14103640',
      apiKey,
      fetchFn,
    });
    try {
      await client.acknowledgeOnboarding('svc_provider_1', 'ws_ack_1', 'sys_env_1');
      expect.fail('expected acknowledgeOnboarding to throw');
    } catch (err) {
      const error = err as Error;
      const causeMessage = error.cause instanceof Error ? error.cause.message : '';
      const combined = `${error.message}\n${causeMessage}`;
      expect(combined).not.toContain(accessToken);
      expect(combined).not.toContain(apiKey);
      expect(error.message).toContain('svc_provider_1');
      expect(error.message).toContain('ws_ack_1');
      expect(error.message).toContain('sys_env_1');
    }
  });

  it('masks secrets on retryable team verification token HttpError', async () => {
    const accessToken = 'tok-verify-secret-abc';
    const apiKey = 'PMAK-verify-secret-xyz';
    const fetchFn = mockFetch([
      {
        ok: false,
        status: 503,
        body: { error: `unavailable token=${accessToken} key=${apiKey}` },
      },
    ]);
    const client = new BifrostCatalogClient({
      accessToken,
      teamId: '14103640',
      apiKey,
      fetchFn,
    });
    try {
      await client.getTeamVerificationToken('ws-verify-1');
      expect.fail('expected getTeamVerificationToken to throw');
    } catch (err) {
      const error = err as Error;
      expect(error.message).not.toContain(accessToken);
      expect(error.message).not.toContain(apiKey);
      expect(error.message).toMatch(/503/);
      expect(error.message).toContain('ws-verify-1');
    }
  }, 20_000);

  it('enriches akita acknowledge failures with token-expiry advice', async () => {
    const fetchFn = mockFetch([
      { ok: true, status: 200, body: { services: [] } },
      {
        ok: false,
        status: 401,
        body: { error: { code: 'UNAUTHENTICATED' } },
      },
    ]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });
    await expect(client.acknowledgeOnboarding('svc_1', 'ws-1', 'sys-1')).rejects.toThrow(
      /Insights acknowledge failed: 401|UNAUTHENTICATED|Re-mint a fresh token|401/
    );
  });

  it('rewrites createApiKey UNAUTHENTICATED failures with token-expiry advice', async () => {
    const fetchFn = mockFetch([{
      ok: false,
      status: 401,
      body: { error: { code: 'UNAUTHENTICATED' } },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: '',
      fetchFn,
    });
    await expect(client.createApiKey('expired-key')).rejects.toThrow(
      /Bifrost rejected the access token \(UNAUTHENTICATED\)/
    );
  });

  it('creates application binding via observability API', async () => {
    const fetchFn = mockFetch([
      { ok: true, status: 200, body: { applications: [] } },
      {
        ok: true,
        status: 200,
        body: { application_id: 'app-123', service_id: 'svc_abc', service_name: '[Production] test', system_env: 'sys-env-456' },
      },
    ]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });
    const result = await client.createApplication('ws-123', 'sys-env-456');
    expect(result.application_id).toBe('app-123');
    expect(result.service_id).toBe('svc_abc');

    const postCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[1]?.method === 'POST'
    );
    expect(postCall).toBeTruthy();
    const [url, opts] = postCall!;
    expect(url).toBe('https://api.observability.postman.com/v2/agent/api-catalog/workspaces/ws-123/applications');
    expect(opts.method).toBe('POST');
    expect(opts.headers['x-api-key']).toBe('PMAK-test');
    expect(opts.headers['x-postman-env']).toBe('production');
    expect(JSON.parse(opts.body)).toEqual({ system_env: 'sys-env-456' });
  });

  it('throws on failed application binding', async () => {
    const fetchFn = mockFetch([
      { ok: true, status: 200, body: { applications: [] } },
      {
        ok: false,
        status: 500,
        body: { message: 'internal error' },
      },
      { ok: true, status: 200, body: { applications: [] } },
    ]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });
    await expect(client.createApplication('ws-bad', 'sys-env-bad'))
      .rejects.toThrow(/failed.*500|500/);
  });

  it('includes x-entity-team-id when teamId is provided', async () => {
    const fetchFn = mockFetch([{
      ok: true,
      status: 200,
      body: { total: 0, nextCursor: null, items: [] },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });
    await client.listDiscoveredServices();

    const callOpts = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const headers = callOpts.headers as Record<string, string>;
    expect(headers['x-entity-team-id']).toBe('14103640');
    expect(headers['x-access-token']).toBe('tok-abc');
  });

  it('omits x-entity-team-id when teamId is empty (non-org mode)', async () => {
    const fetchFn = mockFetch([{
      ok: true,
      status: 200,
      body: { total: 0, nextCursor: null, items: [] },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '',
      apiKey: 'PMAK-test',
      fetchFn,
    });
    await client.listDiscoveredServices();

    const callOpts = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const headers = callOpts.headers as Record<string, string>;
    expect(headers['x-entity-team-id']).toBeUndefined();
    expect(headers['x-access-token']).toBe('tok-abc');
  });

  it('creates an API key via Bifrost identity service', async () => {
    const fetchFn = mockFetch([{
      ok: true,
      status: 200,
      body: { apikey: { key: 'PMAK-new-key-123', name: 'test-key', type: 'v2' } },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: '',
      fetchFn,
    });
    const key = await client.createApiKey('test-key');
    expect(key).toBe('PMAK-new-key-123');

    const callBody = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(callBody.service).toBe('identity');
    expect(callBody.method).toBe('POST');
    expect(callBody.path).toBe('/api/keys');
    expect(callBody.body.apikey.name).toBe('test-key');
  });

  it('throws when createApiKey response has no key', async () => {
    const fetchFn = mockFetch([{
      ok: true,
      status: 200,
      body: { apikey: {} },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: '',
      fetchFn,
    });
    await expect(client.createApiKey('test-key'))
      .rejects.toThrow('Failed to extract API key');
  });

  it('throws on failed createApiKey request', async () => {
    const fetchFn = mockFetch([{
      ok: false,
      status: 401,
      body: { error: 'unauthorized' },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: '',
      fetchFn,
    });
    await expect(client.createApiKey('test-key'))
      .rejects.toThrow(/failed.*401/);
  });

  it('follows pagination cursors in listDiscoveredServices', async () => {
    const page1Service: DiscoveredService = {
      ...sampleServices[0],
      id: 1001,
      name: 'cluster-a/svc-1',
    };
    const page2Service: DiscoveredService = {
      ...sampleServices[0],
      id: 1002,
      name: 'cluster-a/svc-2',
    };
    const fetchFn = mockFetch([
      {
        ok: true,
        status: 200,
        body: { total: 2, nextCursor: 'cursor-page2', items: [page1Service] },
      },
      {
        ok: true,
        status: 200,
        body: { total: 2, nextCursor: null, items: [page2Service] },
      },
    ]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });
    const services = await client.listDiscoveredServices();
    expect(services).toHaveLength(2);
    expect(services[0].id).toBe(1001);
    expect(services[1].id).toBe(1002);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('defaults bifrost base URL to prod host', async () => {
    const fetchFn = mockFetch([{
      ok: true,
      status: 200,
      body: { total: 0, nextCursor: null, items: [] },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });
    await client.listDiscoveredServices();

    const url = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(url).toBe('https://bifrost-premium-https-v4.gw.postman.com/ws/proxy');
  });

  it('routes bifrost calls through a custom base URL when provided', async () => {
    const fetchFn = mockFetch([
      { ok: true, status: 200, body: { total: 0, nextCursor: null, items: [] } },
      { ok: true, status: 200, body: { apikey: { key: 'PMAK-new' } } },
    ]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
      bifrostBaseUrl: 'https://bifrost-beta.gw.postman-beta.com/',
    });
    await client.listDiscoveredServices();
    await client.createApiKey('beta-key');

    const urls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
    // Trailing slash is normalized away; /ws/proxy appended for both api-catalog and identity services.
    expect(urls[0]).toBe('https://bifrost-beta.gw.postman-beta.com/ws/proxy');
    expect(urls[1]).toBe('https://bifrost-beta.gw.postman-beta.com/ws/proxy');
  });

  it('setApiKey updates the key used for observability calls', async () => {
    const fetchFn = mockFetch([{
      ok: true,
      status: 200,
      body: { application_id: 'app-new', service_id: 'svc_new' },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-old',
      fetchFn,
    });
    client.setApiKey('PMAK-new');
    await client.createApplication('ws-123', 'sys-env-456');

    const callOpts = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const headers = callOpts.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('PMAK-new');
  });

  it('defaults observability base URL to prod host', async () => {
    const fetchFn = mockFetch([{
      ok: true,
      status: 200,
      body: { application_id: 'app-123', service_id: 'svc-456' },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });
    await client.createApplication('ws-abc', 'env-xyz');

    const url = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(url).toBe('https://api.observability.postman.com/v2/agent/api-catalog/workspaces/ws-abc/applications');
  });

  it('routes observability calls through a custom base URL when provided', async () => {
    const fetchFn = mockFetch([{
      ok: true,
      status: 200,
      body: { application_id: 'app-beta', service_id: 'svc-beta' },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
      observabilityBaseUrl: 'https://api.observability.postman-beta.com/',
    });
    await client.createApplication('ws-beta', 'env-beta');

    const url = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Trailing slash is normalized away
    expect(url).toBe('https://api.observability.postman-beta.com/v2/agent/api-catalog/workspaces/ws-beta/applications');
  });

  it('uses beta x-postman-env for beta observability profile', async () => {
    const fetchFn = mockFetch([{
      ok: true,
      status: 200,
      body: { application_id: 'app-beta', service_id: 'svc-beta' },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
      observabilityBaseUrl: 'https://api.observability.postman-beta.com/',
      observabilityEnv: 'beta',
    });
    await client.createApplication('ws-beta', 'env-beta');

    const opts = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.headers['x-postman-env']).toBe('beta');
  });

  it('stops discovered-service pagination on repeated cursors', async () => {
    const fetchFn = mockFetch([
      {
        ok: true,
        status: 200,
        body: { total: 10, nextCursor: 'cursor-loop', items: [sampleServices[0]] },
      },
      {
        ok: true,
        status: 200,
        body: { total: 10, nextCursor: 'cursor-loop', items: [sampleServices[1]] },
      },
    ]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });

    await expect(client.listDiscoveredServices()).resolves.toHaveLength(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('stops provider service pagination when total count is reached', async () => {
    const fetchFn = mockFetch([
      {
        ok: true,
        status: 200,
        body: {
          total: 1,
          services: [{ id: 'svc-1', name: 'cluster-a/service-a' }],
        },
      },
    ]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });

    await expect(client.resolveProviderServiceId('service-a', 'cluster-a')).resolves.toBe('svc-1');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('resolves provider service id from a bracketed Jira key in the final segment', async () => {
    const fetchFn = mockFetch([{
      ok: true,
      status: 200,
      body: {
        services: [
          { id: 'svc_xray_123', name: 'se-catalog-demo/[PROJ-123] my tests' },
        ],
      },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });

    await expect(client.resolveProviderServiceId('PROJ-123')).resolves.toBe('svc_xray_123');
  });

  it('does not resolve provider service id from cluster token overlap', async () => {
    const fetchFn = mockFetch([{
      ok: true,
      status: 200,
      body: {
        services: [
          { id: 'svc_activation', name: 'se-catalog-demo/af-cards-activation' },
        ],
      },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });

    await expect(client.resolveProviderServiceId('catalog')).resolves.toBeNull();
  });

  it('does not resolve provider service id from a partial final segment', async () => {
    const fetchFn = mockFetch([{
      ok: true,
      status: 200,
      body: {
        services: [
          { id: 'svc_activation', name: 'se-catalog-demo/af-cards-activation' },
        ],
      },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });

    await expect(client.resolveProviderServiceId('af-cards')).resolves.toBeNull();
  });
});

describe('findDiscoveredService', () => {
  it('matches by full cluster/name', () => {
    const match = findDiscoveredService(sampleServices, 'af-cards-activation', 'se-catalog-demo');
    expect(match?.id).toBe(24701);
  });

  it('falls back to suffix match without cluster', () => {
    const match = findDiscoveredService(sampleServices, 'af-cards-authorization');
    expect(match?.id).toBe(24751);
  });

  it('does NOT fall back to suffix match when cluster is provided but no exact match', () => {
    const match = findDiscoveredService(sampleServices, 'af-cards-activation', 'wrong-cluster');
    expect(match).toBeUndefined();
  });

  it('returns undefined when no match', () => {
    const match = findDiscoveredService(sampleServices, 'nonexistent', 'se-catalog-demo');
    expect(match).toBeUndefined();
  });

  it('matches a bracketed Jira key in the final segment', () => {
    const xrayServices: DiscoveredService[] = [
      {
        ...sampleServices[0],
        id: 24777,
        name: 'se-catalog-demo/[PROJ-123] my tests',
      },
    ];

    const match = findDiscoveredService(xrayServices, 'PROJ-123');
    expect(match?.id).toBe(24777);
  });

  it('does not match a cluster token overlap when cluster is omitted', () => {
    const match = findDiscoveredService(sampleServices, 'catalog');
    expect(match).toBeUndefined();
  });

  it('does not match a partial final segment when cluster is omitted', () => {
    const match = findDiscoveredService(sampleServices, 'af-cards');
    expect(match).toBeUndefined();
  });
});
