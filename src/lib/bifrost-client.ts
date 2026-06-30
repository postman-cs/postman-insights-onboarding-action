import { getMemoizedSessionIdentity } from './credential-identity.js';
import { adviseFromBifrostBody, adviseFromHttpError, type ErrorAdviceContext } from './error-advice.js';
import { HttpError } from './http-error.js';
import { retry } from './retry.js';
import { createSecretMasker } from './secrets.js';
import { POSTMAN_ENDPOINT_PROFILES } from './postman/base-urls.js';
import { AccessTokenProvider } from './postman/token-provider.js';

const DEFAULT_BIFROST_BASE_URL = POSTMAN_ENDPOINT_PROFILES.prod.bifrostBaseUrl;
const BIFROST_PROXY_PATH = '/ws/proxy';
const DEFAULT_OBSERVABILITY_BASE_URL = POSTMAN_ENDPOINT_PROFILES.prod.observabilityBaseUrl;
const DEFAULT_OBSERVABILITY_ENV = POSTMAN_ENDPOINT_PROFILES.prod.observabilityEnv;
const MAX_DISCOVERED_SERVICE_PAGES = 100;
const MAX_PROVIDER_SERVICE_PAGES = 100;

export interface DiscoveredService {
  id: number;
  name: string;
  version: string | null;
  sourceEnvironment: string | null;
  systemEnvironmentId: string | null;
  status: string;
  endpointsCount: number;
  connectionId: number;
  connectionType: string;
  tags: string[];
  discoveredAt: string;
}

interface DiscoveredServicesResponse {
  total: number;
  nextCursor: string | null;
  items: DiscoveredService[];
}

export interface OnboardGitParams {
  serviceId: number;
  workspaceId: string;
  environmentId: string;
  gitRepositoryUrl: string;
  gitApiKey?: string;
}

export interface BifrostClientOptions {
  /** Live access token holder; preferred over a static accessToken string. */
  tokenProvider?: AccessTokenProvider;
  accessToken: string;
  teamId: string;
  apiKey: string;
  fetchFn?: typeof globalThis.fetch;
  /**
   * Base URL for the Bifrost gateway (override for beta/staging stacks).
   * Defaults to the prod host; `/ws/proxy` is appended automatically.
   */
  bifrostBaseUrl?: string;
  /**
   * Base URL for the Observability API (override for beta/staging stacks).
   * Defaults to https://api.observability.postman.com.
   */
  observabilityBaseUrl?: string;
  observabilityEnv?: string;
}

function isExpiredAuthError(status: number, body: string): boolean {
  return (
    status === 401 ||
    body.includes('UNAUTHENTICATED') ||
    body.includes('authenticationError')
  );
}

export class BifrostCatalogClient {
  private readonly tokenProvider: AccessTokenProvider;
  private readonly teamId: string;
  private apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly secretValues: string[];
  private readonly bifrostProxyUrl: string;
  private readonly observabilityBaseUrl: string;
  private readonly observabilityEnv: string;

  constructor(options: BifrostClientOptions) {
    this.tokenProvider =
      options.tokenProvider ??
      new AccessTokenProvider({
        accessToken: options.accessToken,
        apiKey: options.apiKey
      });
    this.teamId = options.teamId;
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.secretValues = [this.tokenProvider.current(), options.apiKey].filter(Boolean);
    const base = (options.bifrostBaseUrl || DEFAULT_BIFROST_BASE_URL).replace(/\/+$/, '');
    this.bifrostProxyUrl = `${base}${BIFROST_PROXY_PATH}`;
    this.observabilityBaseUrl = (options.observabilityBaseUrl || DEFAULT_OBSERVABILITY_BASE_URL).replace(/\/+$/, '');
    this.observabilityEnv = options.observabilityEnv || DEFAULT_OBSERVABILITY_ENV;
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
    if (apiKey && !this.secretValues.includes(apiKey)) {
      this.secretValues.push(apiKey);
    }
  }

  private registerAccessToken(token: string): void {
    if (token && !this.secretValues.includes(token)) {
      this.secretValues.push(token);
    }
  }

  /**
   * Build Bifrost proxy headers.
   * x-entity-team-id is ONLY included when teamId is present (org-mode tokens).
   * Non-org-mode tokens must OMIT it so Bifrost resolves team from the access token.
   */
  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'x-access-token': this.tokenProvider.current(),
      'Content-Type': 'application/json',
    };
    if (this.teamId) {
      h['x-entity-team-id'] = this.teamId;
    }
    return h;
  }

  /**
   * Reactive error-advice context. The session identity comes from the credential
   * preflight's in-process memo when it ran; the advice degrades gracefully without it.
   */
  private adviceContext(operation: string): ErrorAdviceContext {
    const session = getMemoizedSessionIdentity();
    return {
      operation,
      hasAccessToken: Boolean(this.tokenProvider.current()),
      sessionTeamId: session?.teamId,
      sessionRoles: session?.roles,
      sessionConsumerType: session?.consumerType,
      explicitTeamId: this.teamId || undefined,
      mask: createSecretMasker(this.secretValues)
    };
  }

  private async proxyRequest<T>(
    method: string,
    path: string,
    body: unknown = {},
    operation = 'api-catalog request'
  ): Promise<T> {
    const send = async (): Promise<Response> =>
      this.fetchFn(this.bifrostProxyUrl, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          service: 'api-catalog',
          method,
          path,
          body
        })
      });

    let response = await send();
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      if (isExpiredAuthError(response.status, bodyText) && this.tokenProvider.canRefresh()) {
        try {
          const refreshed = await this.tokenProvider.refresh();
          this.registerAccessToken(refreshed);
          response = await send();
        } catch {
          const httpErr = await HttpError.fromResponse(
            new Response(bodyText, { status: response.status, headers: response.headers }),
            {
              method: 'POST',
              url: `bifrost:api-catalog:${method} ${path}`,
              secretValues: this.secretValues
            }
          );
          const advised = adviseFromHttpError(httpErr, this.adviceContext(operation));
          throw advised ?? httpErr;
        }
      } else {
        const httpErr = await HttpError.fromResponse(
          new Response(bodyText, { status: response.status, headers: response.headers }),
          {
            method: 'POST',
            url: `bifrost:api-catalog:${method} ${path}`,
            secretValues: this.secretValues
          }
        );
        const advised = adviseFromHttpError(httpErr, this.adviceContext(operation));
        throw advised ?? httpErr;
      }
    }

    if (!response.ok) {
      const httpErr = await HttpError.fromResponse(response, {
        method: 'POST',
        url: `bifrost:api-catalog:${method} ${path}`,
        secretValues: this.secretValues
      });
      const advised = adviseFromHttpError(httpErr, this.adviceContext(operation));
      throw advised ?? httpErr;
    }

    const data = (await response.json()) as T & { error?: { message?: string; code?: string } };
    if (data && typeof data === 'object' && 'error' in data && (data as Record<string, unknown>).error) {
      const errObj = (data as Record<string, { message?: string; code?: string }>).error;
      const advised = adviseFromBifrostBody(
        response.status,
        JSON.stringify({ error: errObj }),
        this.adviceContext(operation)
      );
      throw advised ?? new Error(`api-catalog error: ${errObj?.message || errObj?.code || 'unknown'}`);
    }

    return data;
  }

  private async akitaProxyRequest<T>(
    method: string,
    path: string,
    body: unknown = {},
    operation = 'Insights request'
  ): Promise<{ ok: boolean; status: number; data: T | null; errorText: string }> {
    const send = async (): Promise<Response> =>
      this.fetchFn(this.bifrostProxyUrl, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          service: 'akita',
          method,
          path,
          body
        })
      });

    let response = await send();
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (isExpiredAuthError(response.status, text) && this.tokenProvider.canRefresh()) {
        try {
          const refreshed = await this.tokenProvider.refresh();
          this.registerAccessToken(refreshed);
          response = await send();
          if (response.ok) {
            const data = (await response.json()) as T;
            return { ok: true, status: response.status, data, errorText: '' };
          }
          const retryText = await response.text().catch(() => '');
          const advised = adviseFromBifrostBody(response.status, retryText, this.adviceContext(operation));
          const errorText = advised ? (retryText ? `${retryText}\n${advised.message}` : advised.message) : retryText;
          return { ok: false, status: response.status, data: null, errorText };
        } catch {
          const advised = adviseFromBifrostBody(response.status, text, this.adviceContext(operation));
          const errorText = advised ? (text ? `${text}\n${advised.message}` : advised.message) : text;
          return { ok: false, status: response.status, data: null, errorText };
        }
      }
      const advised = adviseFromBifrostBody(response.status, text, this.adviceContext(operation));
      const errorText = advised ? (text ? `${text}\n${advised.message}` : advised.message) : text;
      return { ok: false, status: response.status, data: null, errorText };
    }
    const data = (await response.json()) as T;
    return { ok: true, status: response.status, data, errorText: '' };
  }

  async listDiscoveredServices(): Promise<DiscoveredService[]> {
    return retry(
      async () => {
        const allItems: DiscoveredService[] = [];
        let cursor: string | null = null;
        const seenCursors = new Set<string>();
        for (let page = 0; page < MAX_DISCOVERED_SERVICE_PAGES; page += 1) {
          const cursorParam: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
          const data: DiscoveredServicesResponse = await this.proxyRequest<DiscoveredServicesResponse>(
            'GET',
            `/api/v1/onboarding/discovered-services?status=discovered${cursorParam}`,
            {},
            'discovered-services listing'
          );
          allItems.push(...(data.items || []));
          if (data.total && allItems.length >= data.total) {
            break;
          }
          const nextCursor = data.nextCursor || null;
          if (!nextCursor || seenCursors.has(nextCursor)) {
            break;
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
        return allItems;
      },
      { maxAttempts: 3, delayMs: 2000, backoffMultiplier: 2 }
    );
  }

  async prepareCollection(serviceId: number, workspaceId: string): Promise<string> {
    return retry(
      async () => {
        const data = await this.proxyRequest<{ id: string }>(
          'POST',
          '/api/v1/onboarding/prepare-collection',
          { service_id: String(serviceId), workspace_id: workspaceId },
          'collection preparation'
        );
        return data.id;
      },
      { maxAttempts: 3, delayMs: 2000, backoffMultiplier: 2 }
    );
  }

  async onboardGit(params: OnboardGitParams): Promise<void> {
    await retry(
      async () => {
        const body: Record<string, unknown> = {
          via_integrations: false,
          git_service_name: 'github',
          workspace_id: params.workspaceId,
          git_repository_url: params.gitRepositoryUrl,
          service_id: params.serviceId,
          environment_id: params.environmentId,
        };
        if (params.gitApiKey) {
          body.git_api_key = params.gitApiKey;
        }
        await this.proxyRequest<{ message?: string }>(
          'POST',
          '/api/v1/onboarding/git',
          body,
          'git onboarding'
        );
      },
      { maxAttempts: 2, delayMs: 3000 }
    );
  }

  async resolveProviderServiceId(
    projectName: string,
    clusterName?: string
  ): Promise<string | null> {
    const allServices: Array<{ id: string; name: string }> = [];
    let page = 1;
    const pageSize = 100;

    for (let pageCount = 0; pageCount < MAX_PROVIDER_SERVICE_PAGES; pageCount += 1) {
      const result = await this.akitaProxyRequest<{ services?: Array<{ id: string; name: string }>; total?: number }>(
        'GET',
        `/v2/api-catalog/services?status=discovered&populate_endpoints=false&populate_discovery_metadata=true&page=${page}&page_size=${pageSize}`,
        {},
        'provider service resolution'
      );
      if (!result.ok || !result.data) return null;
      const services = result.data.services || [];
      allServices.push(...services);
      if (result.data.total && allServices.length >= result.data.total) {
        break;
      }
      if (services.length < pageSize) {
        break;
      }
      page++;
    }

    if (clusterName) {
      const fullName = `${clusterName}/${projectName}`;
      const exactMatch = allServices.find((s) => s.name === fullName);
      return exactMatch?.id || null;
    }

    const finalSegmentMatch = allServices.find(
      (s) => getFinalServiceSegment(s.name) === projectName
    );
    if (finalSegmentMatch) return finalSegmentMatch.id;

    const bracketedMatch = allServices.find(
      (s) => getFinalServiceSegment(s.name).includes(`[${projectName}]`)
    );
    return bracketedMatch?.id || null;
  }

  async acknowledgeOnboarding(
    providerServiceId: string,
    workspaceId: string,
    systemEnvironmentId: string
  ): Promise<void> {
    const result = await this.akitaProxyRequest<unknown>(
      'POST',
      '/v2/api-catalog/services/onboard',
      {
        services: [{
          service_id: providerServiceId,
          workspace_id: workspaceId,
          system_env: systemEnvironmentId
        }]
      },
      'Insights onboarding acknowledgment'
    );
    if (!result.ok) {
      throw new Error(`Insights acknowledge failed: ${result.status} ${result.errorText}`);
    }
  }

  async acknowledgeWorkspace(workspaceId: string): Promise<void> {
    const result = await this.akitaProxyRequest<unknown>(
      'POST',
      `/v2/workspaces/${workspaceId}/onboarding/acknowledge`,
      {},
      'workspace onboarding acknowledgment'
    );
    if (!result.ok) {
      throw new Error(`Workspace acknowledge failed: ${result.status} ${result.errorText}`);
    }
  }

  // PMAK-only by proven exception. A live probe against the observability
  // application-binding endpoint (POST /v2/agent/api-catalog/workspaces/:id/
  // applications) showed x-access-token is rejected identically to the x-api-key
  // control: both return 401 {"message":"Postman User not found"} for a
  // service-account credential, because the observability service has no
  // "Postman User" for a service account. The access token offers no improvement
  // over the API key here, so this route is not migrated to access-token-primary
  // (the suite-wide migration explicitly leaves probe-failed routes on PMAK).
  async createApplication(
    workspaceId: string,
    systemEnv: string,
  ): Promise<{ application_id: string; service_id: string }> {
    const response = await this.fetchFn(
      `${this.observabilityBaseUrl}/v2/agent/api-catalog/workspaces/${workspaceId}/applications`,
      {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'x-postman-env': this.observabilityEnv,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ system_env: systemEnv }),
      },
    );
    if (!response.ok) {
      const httpErr = await HttpError.fromResponse(response, {
        method: 'POST',
        url: `observability:createApplication(${workspaceId})`,
        secretValues: this.secretValues,
      });
      const advised = adviseFromHttpError(httpErr, this.adviceContext('application binding'));
      throw advised ?? httpErr;
    }
    return response.json() as Promise<{ application_id: string; service_id: string }>;
  }

  async getTeamVerificationToken(workspaceId: string): Promise<string | null> {
    const result = await this.akitaProxyRequest<{ team_verification_token?: string }>(
      'GET',
      `/v2/workspaces/${workspaceId}/team-verification-token`,
      {},
      'team verification token retrieval'
    );
    if (!result.ok || !result.data) return null;
    return result.data.team_verification_token || null;
  }

  async createApiKey(name: string): Promise<string> {
    const response = await this.fetchFn(this.bifrostProxyUrl, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        service: 'identity',
        method: 'POST',
        path: '/api/keys',
        body: { apikey: { name, type: 'v2' } }
      })
    });

    if (!response.ok) {
      const httpErr = await HttpError.fromResponse(response, {
        method: 'POST',
        url: 'bifrost:identity:POST /api/keys',
        secretValues: this.secretValues,
      });
      const advised = adviseFromHttpError(httpErr, this.adviceContext('API key creation'));
      throw advised ?? httpErr;
    }

    const data = await response.json() as Record<string, unknown>;
    const apikey = data?.apikey as Record<string, unknown> | undefined;
    if (!apikey?.key) {
      throw new Error('Failed to extract API key from Bifrost identity response');
    }

    return String(apikey.key);
  }
}

export function findDiscoveredService(
  services: DiscoveredService[],
  projectName: string,
  clusterName?: string
): DiscoveredService | undefined {
  if (clusterName) {
    const fullName = `${clusterName}/${projectName}`;
    return services.find((s) => s.name === fullName);
  }

  const finalSegmentMatch = services.find(
    (service) => getFinalServiceSegment(service.name) === projectName
  );
  if (finalSegmentMatch) return finalSegmentMatch;

  return services.find(
    (service) => getFinalServiceSegment(service.name).includes(`[${projectName}]`)
  );
}

function getFinalServiceSegment(serviceName: string): string {
  const lastSlash = serviceName.lastIndexOf('/');
  return lastSlash === -1 ? serviceName : serviceName.slice(lastSlash + 1);
}
