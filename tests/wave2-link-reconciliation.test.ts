import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveApiKeyAndTeamId,
  resolveInputs,
  runOnboarding,
  type ActionInputs,
  type Reporter
} from '../src/index.js';
import {
  BifrostCatalogClient,
  findDiscoveredService,
  type DiscoveredService
} from '../src/lib/bifrost-client.js';
import { HttpError } from '../src/lib/http-error.js';
import {
  isAmbiguousMutationFailure,
  isTransientHttpStatus,
  shouldRetryReadError
} from '../src/lib/retry.js';

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    projectName: 'af-cards-activation',
    workspaceId: 'ws-123',
    environmentId: 'env-456',
    systemEnvironmentId: 'sys-env-1',
    clusterName: 'se-catalog-demo',
    repoUrl: 'https://github.com/postman-cs/af-cards-activation',
    postmanAccessToken: 'tok-abc',
    postmanApiKey: 'PMAK-test',
    postmanTeamId: '14103640',
    githubToken: 'ghp_test',
    credentialPreflight: 'enforce',
    createApiKey: false,
    serviceNotFoundPolicy: 'fail',
    pollTimeoutSeconds: 5,
    pollIntervalSeconds: 1,
    postmanRegion: 'us',
    postmanStack: 'prod',
    postmanApiBase: 'https://api.getpostman.com',
    postmanBifrostBase: 'https://bifrost-premium-https-v4.gw.postman.com',
    postmanIapubBase: 'https://iapub.postman.co',
    postmanObservabilityBase: 'https://api.observability.postman.com',
    postmanObservabilityEnv: 'production',
    ...overrides
  };
}

const sampleService: DiscoveredService = {
  id: 24701,
  name: 'se-catalog-demo/af-cards-activation',
  version: null,
  sourceEnvironment: null,
  systemEnvironmentId: 'sys-env-1',
  status: 'discovered',
  endpointsCount: 0,
  connectionId: 4501,
  connectionType: 'insights_project',
  tags: [],
  discoveredAt: '2026-03-09T23:47:25.000Z'
};

function silentReporter(): Reporter {
  return { info: () => undefined, warning: () => undefined, setSecret: () => undefined };
}

function ambiguousDisconnect(status = 503): HttpError {
  return new HttpError({
    method: 'POST',
    url: 'bifrost:api-catalog:POST /mutation',
    status,
    statusText: 'Service Unavailable',
    responseBody: 'upstream accepted then disconnected'
  });
}

describe('retry classification', () => {
  it('treats 408/429/5xx as transient and ordinary 4xx as non-retryable', () => {
    expect(isTransientHttpStatus(408)).toBe(true);
    expect(isTransientHttpStatus(429)).toBe(true);
    expect(isTransientHttpStatus(500)).toBe(true);
    expect(isTransientHttpStatus(503)).toBe(true);
    expect(isTransientHttpStatus(400)).toBe(false);
    expect(isTransientHttpStatus(403)).toBe(false);
    expect(isTransientHttpStatus(404)).toBe(false);
  });

  it('retries safe reads only on transient status and never on ordinary 4xx', () => {
    expect(shouldRetryReadError(ambiguousDisconnect(503))).toBe(true);
    expect(shouldRetryReadError(ambiguousDisconnect(429))).toBe(true);
    expect(
      shouldRetryReadError(
        new HttpError({
          method: 'GET',
          url: 'bifrost:read',
          status: 403,
          statusText: 'Forbidden',
          responseBody: 'no'
        })
      )
    ).toBe(false);
    expect(shouldRetryReadError(new Error('fetch failed'))).toBe(true);
  });

  it('classifies disconnect/5xx after mutation as ambiguous', () => {
    expect(isAmbiguousMutationFailure(ambiguousDisconnect(503))).toBe(true);
    expect(isAmbiguousMutationFailure(ambiguousDisconnect(502))).toBe(true);
    expect(isAmbiguousMutationFailure(new Error('network reset'))).toBe(true);
    expect(
      isAmbiguousMutationFailure(
        new HttpError({
          method: 'POST',
          url: 'bifrost:write',
          status: 403,
          statusText: 'Forbidden',
          responseBody: 'no'
        })
      )
    ).toBe(false);
  });
});

describe('ambiguous service identity', () => {
  it('requires cluster-name when multiple final-segment matches exist', () => {
    const services: DiscoveredService[] = [
      { ...sampleService, id: 1, name: 'cluster-a/af-cards-activation' },
      { ...sampleService, id: 2, name: 'cluster-b/af-cards-activation' }
    ];
    expect(() => findDiscoveredService(services, 'af-cards-activation')).toThrow(
      /cluster-name is required/i
    );
  });

  it('returns the exact cluster/project match and exposes canonical identity', () => {
    const services: DiscoveredService[] = [
      { ...sampleService, id: 1, name: 'cluster-a/af-cards-activation' },
      { ...sampleService, id: 2, name: 'cluster-b/af-cards-activation' }
    ];
    const match = findDiscoveredService(services, 'af-cards-activation', 'cluster-b');
    expect(match?.id).toBe(2);
    expect(match?.canonicalIdentity).toEqual({
      serviceId: 2,
      serviceName: 'cluster-b/af-cards-activation',
      clusterName: 'cluster-b',
      projectName: 'af-cards-activation'
    });
  });
});

describe('omitted team header / no PMAK team inference', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('never sends x-entity-team-id when postman-team-id and POSTMAN_TEAM_ID are omitted', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ total: 0, nextCursor: null, items: [] }),
        text: async () => '{}'
      };
    });
    const client = new BifrostCatalogClient({
      accessToken: 'tok-abc',
      teamId: '',
      apiKey: 'PMAK-test',
      fetchFn: fetchFn as unknown as typeof fetch
    });
    await client.listDiscoveredServices();
    const callInit = (fetchFn.mock.calls[0] as unknown[])[1] as RequestInit | undefined;
    const headers = (callInit?.headers ?? {}) as Record<string, string>;
    expect(headers['x-entity-team-id']).toBeUndefined();
  });

  it('does not infer team id from PMAK /teams or /me', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith('/me')) {
        return { ok: true, json: async () => ({ user: { teamId: 99999, username: 'ada' } }) };
      }
      if (String(url).endsWith('/teams')) {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: 10, name: 'Only Team', organizationId: 999 }]
          })
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const client = {
      createApiKey: vi.fn(),
      setApiKey: vi.fn()
    } as unknown as BifrostCatalogClient;

    const result = await resolveApiKeyAndTeamId(
      makeInputs({ postmanTeamId: '', postmanApiKey: 'PMAK-test' }),
      client,
      silentReporter()
    );
    expect(result.teamId).toBe('');
    expect(result.apiKey).toBe('PMAK-test');
    expect(client.createApiKey).not.toHaveBeenCalled();
    expect(String(globalThis.fetch).includes('teams') || true).toBe(true);
    const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith('/teams'))).toBe(false);
  });

  it('uses only explicit postman-team-id / POSTMAN_TEAM_ID for the header', () => {
    const fromInput = resolveInputs({
      INPUT_PROJECT_NAME: 'svc',
      INPUT_WORKSPACE_ID: 'ws',
      INPUT_ENVIRONMENT_ID: 'env',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok',
      INPUT_POSTMAN_TEAM_ID: '555'
    });
    expect(fromInput.postmanTeamId).toBe('555');

    const fromEnv = resolveInputs({
      INPUT_PROJECT_NAME: 'svc',
      INPUT_WORKSPACE_ID: 'ws',
      INPUT_ENVIRONMENT_ID: 'env',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok',
      POSTMAN_TEAM_ID: '777'
    });
    expect(fromEnv.postmanTeamId).toBe('777');
  });
});

describe('no ordinary timestamp API-key orphan creation', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('does not create a durable API key when the provided key is invalid', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: { teamId: 14103640, username: 'ada' } })
      }) as unknown as typeof fetch;

    const client = {
      createApiKey: vi.fn().mockResolvedValue('PMAK-generated'),
      setApiKey: vi.fn()
    } as unknown as BifrostCatalogClient;

    await expect(
      resolveApiKeyAndTeamId(
        makeInputs({ postmanApiKey: 'PMAK-bad', createApiKey: false }),
        client,
        silentReporter()
      )
    ).rejects.toThrow(/postman-api-key is invalid|required|create-api-key/i);
    expect(client.createApiKey).not.toHaveBeenCalled();
  });

  it('does not create a durable API key when no key is provided', async () => {
    const client = {
      createApiKey: vi.fn().mockResolvedValue('PMAK-generated'),
      setApiKey: vi.fn()
    } as unknown as BifrostCatalogClient;

    await expect(
      resolveApiKeyAndTeamId(
        makeInputs({ postmanApiKey: '', createApiKey: false }),
        client,
        silentReporter()
      )
    ).rejects.toThrow(/postman-api-key|create-api-key/i);
    expect(client.createApiKey).not.toHaveBeenCalled();
  });

  it('creates a durable API key only when create-api-key is explicitly opted in', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user: { teamId: 14103640, username: 'ada' } })
      }) as unknown as typeof fetch;

    const client = {
      createApiKey: vi.fn().mockResolvedValue('PMAK-opt-in'),
      setApiKey: vi.fn()
    } as unknown as BifrostCatalogClient;

    const result = await resolveApiKeyAndTeamId(
      makeInputs({ postmanApiKey: 'PMAK-bad', createApiKey: true, projectName: 'payments' }),
      client,
      silentReporter()
    );
    expect(result.apiKey).toBe('PMAK-opt-in');
    expect(client.createApiKey).toHaveBeenCalledTimes(1);
    const keyName = (client.createApiKey as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(keyName).not.toMatch(/\d{10,}/);
    expect(keyName).toContain('payments');
  });
});

describe('service-not-found policy', () => {
  it('fails full linking when the service is not found by default', async () => {
    const client = {
      listDiscoveredServices: vi.fn().mockResolvedValue([]),
      prepareCollection: vi.fn(),
      onboardGit: vi.fn()
    } as unknown as BifrostCatalogClient;

    await expect(
      runOnboarding(makeInputs({ pollTimeoutSeconds: 0, serviceNotFoundPolicy: 'fail' }), client, vi.fn(), silentReporter())
    ).rejects.toThrow(/not found/i);
    expect(client.prepareCollection).not.toHaveBeenCalled();
  });

  it('allows warn policy to return not-found without writes', async () => {
    const client = {
      listDiscoveredServices: vi.fn().mockResolvedValue([]),
      prepareCollection: vi.fn()
    } as unknown as BifrostCatalogClient;

    const result = await runOnboarding(
      makeInputs({ pollTimeoutSeconds: 0, serviceNotFoundPolicy: 'warn' }),
      client,
      vi.fn(),
      silentReporter()
    );
    expect(result.status).toBe('not-found');
    expect(client.prepareCollection).not.toHaveBeenCalled();
  });

  it('fails when the canonical provider service is absent before any linking write', async () => {
    const client = {
      listDiscoveredServices: vi.fn().mockResolvedValue([sampleService]),
      resolveProviderServiceId: vi.fn().mockResolvedValue(null),
      prepareCollection: vi.fn(),
      onboardGit: vi.fn(),
      acknowledgeOnboarding: vi.fn()
    } as unknown as BifrostCatalogClient;

    await expect(runOnboarding(makeInputs(), client, vi.fn(), silentReporter())).rejects.toThrow(
      /provider service.*not found|canonical service identity/i
    );
    expect(client.prepareCollection).not.toHaveBeenCalled();
    expect(client.onboardGit).not.toHaveBeenCalled();
    expect(client.acknowledgeOnboarding).not.toHaveBeenCalled();
  });
});

describe('accepted-write-then-disconnect/5xx reconcile per linking phase', () => {
  function scriptedFetch(handlers: Array<(req: { url: string; body: unknown }) => Response | Promise<Response>>) {
    let i = 0;
    return vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const handler = handlers[i] ?? handlers[handlers.length - 1];
      i += 1;
      return handler({ url: String(url), body });
    }) as unknown as typeof fetch;
  }

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: new Headers()
    } as Response;
  }

  it('prepareCollection POSTs once then adopts via read-back after 503', async () => {
    let preparePosts = 0;
    const fetchFn = scriptedFetch([
      // initial reconcile miss
      () =>
        jsonResponse(200, {
          total: 1,
          nextCursor: null,
          items: [{ ...sampleService, status: 'discovered', collectionId: null, workspaceId: null }]
        }),
      // mutation accepted then 503
      () => {
        preparePosts += 1;
        return jsonResponse(503, { error: 'upstream' });
      },
      // read-back exact match
      () =>
        jsonResponse(200, {
          total: 1,
          nextCursor: null,
          items: [
            {
              ...sampleService,
              status: 'integrated',
              collectionId: 'col-adopted',
              workspaceId: 'ws-123'
            }
          ]
        })
    ]);

    const client = new BifrostCatalogClient({
      accessToken: 'tok',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn
    });

    await expect(client.prepareCollection(24701, 'ws-123')).resolves.toBe('col-adopted');
    expect(preparePosts).toBe(1);
  });

  it('onboardGit POSTs once then adopts exact service/workspace/environment/repo match after 503', async () => {
    let gitPosts = 0;
    const fetchFn = scriptedFetch([
      () =>
        jsonResponse(200, {
          total: 1,
          nextCursor: null,
          items: [
            {
              ...sampleService,
              status: 'discovered',
              workspaceId: null,
              environmentId: null,
              gitRepositoryUrl: null
            }
          ]
        }),
      () => {
        gitPosts += 1;
        return jsonResponse(503, { error: 'upstream' });
      },
      () =>
        jsonResponse(200, {
          total: 1,
          nextCursor: null,
          items: [
            {
              ...sampleService,
              status: 'integrated',
              workspaceId: 'ws-123',
              environmentId: 'env-456',
              gitRepositoryUrl: 'https://github.com/postman-cs/af-cards-activation'
            }
          ]
        })
    ]);

    const client = new BifrostCatalogClient({
      accessToken: 'tok',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn
    });

    await expect(
      client.onboardGit({
        serviceId: 24701,
        workspaceId: 'ws-123',
        environmentId: 'env-456',
        gitRepositoryUrl: 'https://github.com/postman-cs/af-cards-activation'
      })
    ).resolves.toBeUndefined();
    expect(gitPosts).toBe(1);
  });

  it('acknowledgeOnboarding POSTs once then adopts after 503', async () => {
    let posts = 0;
    const fetchFn = scriptedFetch([
      () => jsonResponse(200, { services: [] }),
      () => {
        posts += 1;
        return jsonResponse(503, { error: 'upstream' });
      },
      () =>
        jsonResponse(200, {
          services: [
            {
              id: 'svc_test123',
              name: 'se-catalog-demo/af-cards-activation',
              workspace_id: 'ws-123',
              system_env: 'sys-env-1',
              status: 'onboarded'
            }
          ]
        })
    ]);

    const client = new BifrostCatalogClient({
      accessToken: 'tok',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn
    });

    await expect(client.acknowledgeOnboarding('svc_test123', 'ws-123', 'sys-env-1')).resolves.toBeUndefined();
    expect(posts).toBe(1);
  });

  it('createApplication POSTs once then adopts after 503', async () => {
    let posts = 0;
    const fetchFn = scriptedFetch([
      () => jsonResponse(200, { applications: [] }),
      () => {
        posts += 1;
        return jsonResponse(503, { message: 'upstream' });
      },
      () =>
        jsonResponse(200, {
          applications: [
            {
              application_id: 'app-adopted',
              service_id: 'svc_test123',
              system_env: 'sys-env-1'
            }
          ]
        })
    ]);

    const client = new BifrostCatalogClient({
      accessToken: 'tok',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn
    });

    await expect(client.createApplication('ws-123', 'sys-env-1')).resolves.toEqual({
      application_id: 'app-adopted',
      service_id: 'svc_test123'
    });
    expect(posts).toBe(1);
  });

  it('acknowledgeWorkspace POSTs once then adopts after 503', async () => {
    let posts = 0;
    const fetchFn = scriptedFetch([
      () => jsonResponse(200, { onboarding_acknowledged: false }),
      () => {
        posts += 1;
        return jsonResponse(503, { error: 'upstream' });
      },
      () => jsonResponse(200, { onboarding_acknowledged: true })
    ]);

    const client = new BifrostCatalogClient({
      accessToken: 'tok',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn
    });

    await expect(client.acknowledgeWorkspace('ws-123')).resolves.toBeUndefined();
    expect(posts).toBe(1);
  });

  it('never retries ordinary 4xx mutation failures', async () => {
    let posts = 0;
    const fetchFn = scriptedFetch([
      () =>
        jsonResponse(200, {
          total: 1,
          nextCursor: null,
          items: [{ ...sampleService, status: 'discovered', collectionId: null, workspaceId: null }]
        }),
      () => {
        posts += 1;
        return jsonResponse(403, { error: 'forbidden' });
      }
    ]);

    const client = new BifrostCatalogClient({
      accessToken: 'tok',
      teamId: '14103640',
      apiKey: 'PMAK-test',
      fetchFn
    });

    await expect(client.prepareCollection(24701, 'ws-123')).rejects.toThrow(/403/);
    expect(posts).toBe(1);
  });
});

describe('failure after each linking phase', () => {
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
      ...overrides
    } as unknown as BifrostCatalogClient;
  }

  async function expectWrappedPhaseFailure(
    client: BifrostCatalogClient,
    causeText: string | RegExp,
    entityPatterns: RegExp[],
    actionPattern: RegExp
  ): Promise<Error> {
    let thrown: unknown;
    try {
      await runOnboarding(makeInputs(), client, vi.fn(), silentReporter());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error;
    expect(err.message).toMatch(causeText);
    for (const pattern of entityPatterns) {
      expect(err.message).toMatch(pattern);
    }
    expect(err.message).toMatch(actionPattern);
    expect(err.message).not.toMatch(/[\r\n]/);
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toMatch(causeText);
    return err;
  }

  it('stops before git when prepareCollection fails', async () => {
    const cause = new Error('prepare failed');
    const client = makeClient({
      prepareCollection: vi.fn().mockRejectedValue(cause)
    });
    const err = await expectWrappedPhaseFailure(
      client,
      /prepare failed/,
      [/24701/, /ws-123/, /se-catalog-demo\/af-cards-activation/],
      /Verify workspace .* exists and the access token can edit it/i
    );
    expect(err.cause).toBe(cause);
    expect(client.onboardGit).not.toHaveBeenCalled();
  });

  it('stops before acknowledge when onboardGit fails', async () => {
    const cause = new Error('git failed');
    const client = makeClient({
      onboardGit: vi.fn().mockRejectedValue(cause)
    });
    const err = await expectWrappedPhaseFailure(
      client,
      /git failed/,
      [/24701/, /ws-123/, /env-456/, /github\.com\/postman-cs\/af-cards-activation/],
      /Verify github-token\/repo ownership/i
    );
    expect(err.cause).toBe(cause);
    expect(client.acknowledgeOnboarding).not.toHaveBeenCalled();
  });

  it('stops before createApplication when acknowledgeOnboarding fails', async () => {
    const cause = new Error('ack failed');
    const client = makeClient({
      acknowledgeOnboarding: vi.fn().mockRejectedValue(cause)
    });
    const err = await expectWrappedPhaseFailure(
      client,
      /ack failed/,
      [/svc_test123/, /ws-123/, /sys-env-1/],
      /Postman-user-identity access token/i
    );
    expect(err.cause).toBe(cause);
    expect(client.createApplication).not.toHaveBeenCalled();
  });

  it('stops before workspace ack when createApplication fails', async () => {
    const cause = new Error('app failed');
    const client = makeClient({
      createApplication: vi.fn().mockRejectedValue(cause)
    });
    const err = await expectWrappedPhaseFailure(
      client,
      /app failed/,
      [/ws-123/, /sys-env-1/, /svc_test123/],
      /Verify the PMAK\/access token belong to the same org\/team/i
    );
    expect(err.cause).toBe(cause);
    expect(client.acknowledgeWorkspace).not.toHaveBeenCalled();
  });

  it('surfaces workspace acknowledge failure after prior phases succeeded', async () => {
    const cause = new Error('workspace ack failed');
    const client = makeClient({
      acknowledgeWorkspace: vi.fn().mockRejectedValue(cause)
    });
    const err = await expectWrappedPhaseFailure(
      client,
      /workspace ack failed/,
      [/ws-123/],
      /Verify workspace\/team access and rerun/i
    );
    expect(err.cause).toBe(cause);
    expect(client.createApplication).toHaveBeenCalled();
  });

  it('collapses multiline entity/cause text in diagnostics while passing raw values to clients', async () => {
    const multilineWorkspace = 'ws-\r\nlinked';
    const multilineRepo = 'https://github.com/postman-cs/af-\rcards\nactivation';
    const cause = new Error('prepare failed\r\nwith detail');
    const prepareCollection = vi.fn().mockRejectedValue(cause);
    const client = makeClient({ prepareCollection });
    const infos: string[] = [];
    const warnings: string[] = [];
    const reporter: Reporter = {
      info: (message: string) => {
        infos.push(message);
      },
      warning: (message: string) => {
        warnings.push(message);
      },
      setSecret: () => undefined
    };

    let thrown: unknown;
    try {
      await runOnboarding(
        makeInputs({ workspaceId: multilineWorkspace, repoUrl: multilineRepo }),
        client,
        vi.fn(),
        reporter
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error;
    expect(err.message).toMatch(/prepare failed with detail/);
    expect(err.message).toMatch(/ws- linked/);
    expect(err.message).not.toMatch(/[\r\n]/);
    expect(err.cause).toBe(cause);
    expect((err.cause as Error).message).toBe('prepare failed\r\nwith detail');
    expect(prepareCollection).toHaveBeenCalledWith(24701, multilineWorkspace);
    for (const message of [...infos, ...warnings]) {
      expect(message).not.toMatch(/[\r\n]/);
    }
  });
});

describe('two fresh-process runs reuse exact linked identity', () => {
  it('second process adopts existing links without repeating mutation POSTs', async () => {
    const linkedState: {
      collectionId: string | null;
      gitLinked: boolean;
      onboarded: boolean;
      application: { application_id: string; service_id: string } | null;
      workspaceAcked: boolean;
    } = {
      collectionId: null,
      gitLinked: false,
      onboarded: false,
      application: null,
      workspaceAcked: false
    };

    function makeFreshClient(): BifrostCatalogClient {
      const posts = {
        prepare: 0,
        git: 0,
        ack: 0,
        app: 0,
        workspace: 0
      };
      return {
        listDiscoveredServices: vi.fn().mockResolvedValue([sampleService]),
        prepareCollection: vi.fn(async () => {
          if (linkedState.collectionId) return linkedState.collectionId;
          posts.prepare += 1;
          linkedState.collectionId = 'col-existing';
          return linkedState.collectionId;
        }),
        onboardGit: vi.fn(async () => {
          if (linkedState.gitLinked) return;
          posts.git += 1;
          linkedState.gitLinked = true;
        }),
        resolveProviderServiceId: vi.fn().mockResolvedValue('svc_existing'),
        acknowledgeOnboarding: vi.fn(async () => {
          if (linkedState.onboarded) return;
          posts.ack += 1;
          linkedState.onboarded = true;
        }),
        createApplication: vi.fn(async () => {
          if (linkedState.application) return linkedState.application;
          posts.app += 1;
          linkedState.application = { application_id: 'app-existing', service_id: 'svc_existing' };
          return linkedState.application;
        }),
        acknowledgeWorkspace: vi.fn(async () => {
          if (linkedState.workspaceAcked) return;
          posts.workspace += 1;
          linkedState.workspaceAcked = true;
        }),
        getTeamVerificationToken: vi.fn().mockResolvedValue('tvt_shared'),
        __posts: posts
      } as unknown as BifrostCatalogClient & { __posts: typeof posts };
    }

    // Process 1
    const first = makeFreshClient() as BifrostCatalogClient & { __posts: Record<string, number> };
    const firstResult = await runOnboarding(makeInputs(), first, vi.fn(), silentReporter());
    expect(firstResult.status).toBe('success');
    expect(firstResult.collectionId).toBe('col-existing');
    expect(first.__posts).toEqual({ prepare: 1, git: 1, ack: 1, app: 1, workspace: 1 });

    // Process 2 — no shared in-memory client, only durable linkedState
    const second = makeFreshClient() as BifrostCatalogClient & { __posts: Record<string, number> };
    const secondResult = await runOnboarding(makeInputs(), second, vi.fn(), silentReporter());
    expect(secondResult.status).toBe('success');
    expect(secondResult.collectionId).toBe('col-existing');
    expect(secondResult.applicationId).toBe('app-existing');
    expect(second.__posts.prepare).toBe(0);
    expect(second.__posts.git).toBe(0);
    expect(second.__posts.ack).toBe(0);
    expect(second.__posts.app).toBe(0);
    expect(second.__posts.workspace).toBe(0);
  });

  it('client-level second run reuses integrated identity without a second prepare POST', async () => {
    let preparePosts = 0;
    const items = [
      {
        ...sampleService,
        status: 'integrated',
        collectionId: 'col-rerun',
        workspaceId: 'ws-123',
        environmentId: 'env-456',
        gitRepositoryUrl: 'https://github.com/postman-cs/af-cards-activation'
      }
    ];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.method === 'POST' && String(body.path).includes('prepare-collection')) {
        preparePosts += 1;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ id: 'col-should-not-create' }),
          text: async () => '{}',
          headers: new Headers()
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ total: 1, nextCursor: null, items }),
        text: async () => JSON.stringify({ total: 1, items }),
        headers: new Headers()
      } as Response;
    }) as unknown as typeof fetch;

    const client = new BifrostCatalogClient({
      accessToken: 'tok',
      teamId: '',
      apiKey: 'PMAK-test',
      fetchFn
    });

    await expect(client.prepareCollection(24701, 'ws-123')).resolves.toBe('col-rerun');
    await expect(client.prepareCollection(24701, 'ws-123')).resolves.toBe('col-rerun');
    expect(preparePosts).toBe(0);
  });
});

describe('canonical service identity through onboarding result', () => {
  it('carries canonical catalog identity on success', async () => {
    const client = {
      listDiscoveredServices: vi.fn().mockResolvedValue([sampleService]),
      prepareCollection: vi.fn().mockResolvedValue('col-abc'),
      onboardGit: vi.fn().mockResolvedValue(undefined),
      resolveProviderServiceId: vi.fn().mockResolvedValue('svc_test123'),
      acknowledgeOnboarding: vi.fn().mockResolvedValue(undefined),
      createApplication: vi.fn().mockResolvedValue({ application_id: 'app-xyz', service_id: 'svc_test123' }),
      acknowledgeWorkspace: vi.fn().mockResolvedValue(undefined),
      getTeamVerificationToken: vi.fn().mockResolvedValue('tvt_test123')
    } as unknown as BifrostCatalogClient;

    const result = await runOnboarding(makeInputs(), client, vi.fn(), silentReporter());
    expect(result.canonicalIdentity).toEqual({
      serviceId: 24701,
      serviceName: 'se-catalog-demo/af-cards-activation',
      clusterName: 'se-catalog-demo',
      projectName: 'af-cards-activation',
      providerServiceId: 'svc_test123'
    });
  });
});
