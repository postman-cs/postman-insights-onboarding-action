/**
 * Deterministic credential × team matrix for Insights' actual Bifrost contract.
 *
 * Axes:
 *   credential: PMAK-only | token-only | both
 *   team:       explicit postman-team-id (org → send x-entity-team-id)
 *               | absent (non-org → omit header)
 *
 * Asserts the resolved Bifrost header and the account-type decision using the
 * existing owning seams (mintAccessTokenIfNeeded, createInsightsTokenProvider,
 * createInsightsBifrostClient, runCredentialPreflight + session memo,
 * createTelemetryContext). No network; no parallel production path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accountTypeFromConsumer,
  createTelemetryContext
} from '@postman-cse/automation-telemetry-core';

import {
  createInsightsBifrostClient,
  createInsightsTokenProvider,
  type ActionInputs,
  type Reporter
} from '../src/index.js';
import {
  __resetIdentityMemo,
  getMemoizedSessionIdentity,
  runCredentialPreflight
} from '../src/lib/credential-identity.js';
import { mintAccessTokenIfNeeded } from '../src/lib/postman/token-provider.js';
import { createSecretMasker } from '../src/lib/secrets.js';

const TEAM_ID = '13347347';
const PMAK = 'PMAK-matrix-test';
const PROVIDED_TOKEN = 'pma_at_provided';
const MINTED_TOKEN = 'pma_at_minted';
const BIFROST = 'https://bifrost-premium-https-v4.gw.postman.com';
const API = 'https://api.getpostman.com';
const IAPUB = 'https://iapub.postman.co';

type CredShape = 'pmak-only' | 'token-only' | 'both';
type TeamShape = 'explicit' | 'absent';

interface MatrixCase {
  cred: CredShape;
  team: TeamShape;
  expectMint: boolean;
  expectAccessToken: string;
  expectHeader: string | undefined;
  expectAccountType: 'service';
}

const MATRIX: MatrixCase[] = (['pmak-only', 'token-only', 'both'] as const).flatMap((cred) =>
  (['explicit', 'absent'] as const).map((team) => ({
    cred,
    team,
    expectMint: cred === 'pmak-only',
    expectAccessToken: cred === 'pmak-only' ? MINTED_TOKEN : PROVIDED_TOKEN,
    expectHeader: team === 'explicit' ? TEAM_ID : undefined,
    expectAccountType: 'service' as const
  }))
);

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    projectName: 'matrix-svc',
    workspaceId: 'ws-matrix',
    environmentId: 'env-matrix',
    systemEnvironmentId: '',
    clusterName: 'cluster-matrix',
    repoUrl: 'https://github.com/postman-cs/matrix-svc',
    postmanAccessToken: '',
    postmanApiKey: '',
    postmanTeamId: '',
    githubToken: '',
    credentialPreflight: 'warn',
    createApiKey: false,
    serviceNotFoundPolicy: 'warn',
    pollTimeoutSeconds: 5,
    pollIntervalSeconds: 1,
    postmanRegion: 'us',
    postmanStack: 'prod',
    postmanApiBase: API,
    postmanBifrostBase: BIFROST,
    postmanIapubBase: IAPUB,
    postmanObservabilityBase: 'https://api.observability.postman.com',
    postmanObservabilityEnv: 'production',
    ...overrides
  };
}

function credOverrides(cred: CredShape): Partial<ActionInputs> {
  switch (cred) {
    case 'pmak-only':
      return { postmanApiKey: PMAK, postmanAccessToken: '' };
    case 'token-only':
      return { postmanApiKey: '', postmanAccessToken: PROVIDED_TOKEN };
    case 'both':
      return { postmanApiKey: PMAK, postmanAccessToken: PROVIDED_TOKEN };
  }
}

function silentReporter(): Reporter {
  return { info: vi.fn(), warning: vi.fn(), setSecret: vi.fn() };
}

function createPlatformFetch(): {
  fetchImpl: typeof fetch;
  mintCount: () => number;
  bifrostHeaders: () => Record<string, string>[];
} {
  let mintCount = 0;
  const bifrostHeaders: Record<string, string>[] = [];

  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;

    if (url === `${API}/service-account-tokens` && method === 'POST') {
      mintCount += 1;
      expect(headers['x-api-key']).toBe(PMAK);
      return new Response(JSON.stringify({ access_token: MINTED_TOKEN }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url === `${API}/me`) {
      return new Response(
        JSON.stringify({
          user: {
            id: 12345678,
            fullName: 'Matrix SA',
            teamId: Number(TEAM_ID),
            teamName: 'field-services-v12-demo',
            teamDomain: 'field-services-v12-demo'
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url === `${IAPUB}/api/sessions/current`) {
      return new Response(
        JSON.stringify({
          identity: { team: Number(TEAM_ID), domain: 'field-services-v12-demo' },
          data: { user: { id: 555, roles: ['admin'] } },
          consumerType: 'service_account'
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url === `${BIFROST}/ws/proxy`) {
      bifrostHeaders.push({ ...headers });
      return new Response(JSON.stringify({ total: 0, nextCursor: null, items: [] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    throw new Error(`Unrouted fetch in insights credential matrix: ${method} ${url}`);
  });

  return {
    fetchImpl,
    mintCount: () => mintCount,
    bifrostHeaders: () => bifrostHeaders
  };
}

beforeEach(() => {
  __resetIdentityMemo();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetIdentityMemo();
});

describe('Insights credential × team matrix (header + account_type)', () => {
  it.each(MATRIX)(
    '$cred × team=$team → mint=$expectMint, header=$expectHeader, account_type=$expectAccountType',
    async ({
      cred,
      team,
      expectMint,
      expectAccessToken,
      expectHeader,
      expectAccountType
    }) => {
      const platform = createPlatformFetch();
      const reporter = silentReporter();
      const inputs = makeInputs({
        ...credOverrides(cred),
        postmanTeamId: team === 'explicit' ? TEAM_ID : ''
      });

      // 1) PMAK-only eager mint (same seam runAction / CLI use).
      const mintHolder = {
        postmanAccessToken: inputs.postmanAccessToken,
        postmanApiKey: inputs.postmanApiKey,
        postmanApiBase: inputs.postmanApiBase
      };
      await mintAccessTokenIfNeeded(
        mintHolder,
        reporter,
        (secret) => reporter.setSecret(secret),
        platform.fetchImpl
      );
      inputs.postmanAccessToken = mintHolder.postmanAccessToken;

      expect(platform.mintCount()).toBe(expectMint ? 1 : 0);
      expect(inputs.postmanAccessToken).toBe(expectAccessToken);

      // 2) Composition root: token provider + Bifrost client with explicit team id only.
      const tokenProvider = createInsightsTokenProvider(inputs, reporter);
      expect(tokenProvider.current()).toBe(expectAccessToken);

      vi.stubGlobal('fetch', platform.fetchImpl);
      const client = createInsightsBifrostClient(
        inputs,
        tokenProvider,
        inputs.postmanTeamId,
        inputs.postmanApiKey
      );
      await client.listDiscoveredServices();

      expect(platform.bifrostHeaders()).toHaveLength(1);
      const headers = platform.bifrostHeaders()[0]!;
      expect(headers['x-access-token']).toBe(expectAccessToken);
      if (expectHeader === undefined) {
        expect(headers['x-entity-team-id']).toBeUndefined();
      } else {
        expect(headers['x-entity-team-id']).toBe(expectHeader);
      }

      // 3) Account-type decision: session consumerType → telemetry enum.
      await runCredentialPreflight({
        apiBaseUrl: inputs.postmanApiBase,
        iapubBaseUrl: inputs.postmanIapubBase,
        postmanAccessToken: inputs.postmanAccessToken,
        postmanApiKey: inputs.postmanApiKey || undefined,
        explicitTeamId: inputs.postmanTeamId || undefined,
        mode: 'warn',
        mask: createSecretMasker([inputs.postmanApiKey, inputs.postmanAccessToken]),
        log: reporter,
        fetchImpl: platform.fetchImpl
      });

      const consumerType = getMemoizedSessionIdentity()?.consumerType;
      const accountType = accountTypeFromConsumer(consumerType);
      expect(consumerType).toBe('service_account');
      expect(accountType).toBe(expectAccountType);

      // 4) Telemetry wiring mirrors entrypoints: setTeamId + setAccountType + emit.
      const transport = vi.fn(async () => new Response(null, { status: 204 }));
      const telemetry = createTelemetryContext({
        action: 'postman-insights-onboarding-action',
        actionVersion: '0.0.0-test',
        // Explicit env overrides vitest's global POSTMAN_ACTIONS_TELEMETRY=off.
        env: { GITHUB_ACTIONS: 'true' },
        transport: transport as unknown as typeof fetch,
        now: () => 1_700_000_000_000
      });
      telemetry.setTeamId(inputs.postmanTeamId);
      telemetry.setAccountType(consumerType);
      telemetry.emitCompletion('success');

      if (team === 'absent') {
        // No team id → emit is a no-op even when telemetry is enabled.
        expect(transport).not.toHaveBeenCalled();
        return;
      }

      await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
      const init = (transport.mock.calls[0] as unknown[])[1] as RequestInit;
      const body = JSON.parse(String(init?.body)) as {
        team_id: string;
        account_type: string;
        action: string;
      };
      expect(body.team_id).toBe(TEAM_ID);
      expect(body.account_type).toBe(expectAccountType);
      expect(body.action).toBe('postman-insights-onboarding-action');
    }
  );
});
