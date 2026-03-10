import { describe, expect, it, vi } from 'vitest';
import { runOnboarding, resolveInputs, type ActionInputs } from '../src/index.js';
import { BifrostCatalogClient, type DiscoveredService } from '../src/lib/bifrost-client.js';

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    projectName: 'af-cards-activation',
    workspaceId: 'ws-123',
    environmentId: 'env-456',
    clusterName: 'se-catalog-demo',
    gitOwner: 'postman-cs',
    gitRepositoryName: 'af-cards-activation',
    postmanAccessToken: 'tok-abc',
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

describe('runOnboarding', () => {
  it('discovers, prepares collection, and onboards git', async () => {
    const client = {
      listDiscoveredServices: vi.fn().mockResolvedValue([sampleService]),
      prepareCollection: vi.fn().mockResolvedValue('col-abc'),
      onboardGit: vi.fn().mockResolvedValue(undefined),
    } as unknown as BifrostCatalogClient;

    const result = await runOnboarding(makeInputs(), client, vi.fn());
    expect(result.status).toBe('success');
    expect(result.discoveredServiceId).toBe(24701);
    expect(result.collectionId).toBe('col-abc');
    expect(client.prepareCollection).toHaveBeenCalledWith(24701, 'ws-123');
    expect(client.onboardGit).toHaveBeenCalledWith({
      serviceId: 24701,
      workspaceId: 'ws-123',
      environmentId: 'env-456',
      gitRepositoryUrl: 'https://github.com/postman-cs/af-cards-activation',
      gitApiKey: 'ghp_test',
    });
  });

  it('returns not-found when service is not discovered within timeout', async () => {
    const client = {
      listDiscoveredServices: vi.fn().mockResolvedValue([]),
      prepareCollection: vi.fn(),
      onboardGit: vi.fn(),
    } as unknown as BifrostCatalogClient;

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
    const client = {
      listDiscoveredServices: vi.fn().mockImplementation(async () => {
        callCount++;
        return callCount >= 3 ? [sampleService] : [];
      }),
      prepareCollection: vi.fn().mockResolvedValue('col-xyz'),
      onboardGit: vi.fn().mockResolvedValue(undefined),
    } as unknown as BifrostCatalogClient;

    const noopSleep = vi.fn();
    const result = await runOnboarding(makeInputs(), client, noopSleep);
    expect(result.status).toBe('success');
    expect(callCount).toBe(3);
    expect(noopSleep).toHaveBeenCalledTimes(2);
  });
});
