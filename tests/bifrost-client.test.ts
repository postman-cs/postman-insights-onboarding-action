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

    const callBody = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(callBody.body.via_integrations).toBe(false);
    expect(callBody.body.service_id).toBe(24701);
    expect(callBody.body.git_api_key).toBe('ghp_test');
  });

  it('throws HttpError on non-ok response after retries', async () => {
    const fetchFn = mockFetch([
      { ok: false, status: 403, body: { error: 'forbidden' } },
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
    })).rejects.toThrow(/failed.*403/);
  }, 15_000);

  it('creates application binding via observability API', async () => {
    const fetchFn = mockFetch([{
      ok: true,
      status: 200,
      body: { application_id: 'app-123', service_id: 'svc_abc', service_name: '[Production] test', system_env: 'sys-env-456' },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });
    const result = await client.createApplication('ws-123', 'sys-env-456');
    expect(result.application_id).toBe('app-123');
    expect(result.service_id).toBe('svc_abc');

    const [url, opts] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.observability.postman.com/v2/agent/api-catalog/workspaces/ws-123/applications');
    expect(opts.method).toBe('POST');
    expect(opts.headers['x-api-key']).toBe('PMAK-test');
    expect(opts.headers['x-postman-env']).toBe('production');
    expect(JSON.parse(opts.body)).toEqual({ system_env: 'sys-env-456' });
  });

  it('throws on failed application binding', async () => {
    const fetchFn = mockFetch([{
      ok: false,
      status: 500,
      body: { message: 'internal error' },
    }]);
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn,
    });
    await expect(client.createApplication('ws-bad', 'sys-env-bad'))
      .rejects.toThrow(/failed.*500/);
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

  it('returns undefined when no match', () => {
    const match = findDiscoveredService(sampleServices, 'nonexistent', 'se-catalog-demo');
    expect(match).toBeUndefined();
  });
});
