import { getMemoizedSessionIdentity } from './credential-identity.js';
import { adviseFromBifrostBody, adviseFromHttpError, type ErrorAdviceContext } from './error-advice.js';
import { HttpError } from './http-error.js';
import {
  isAmbiguousMutationFailure,
  retry,
  SAFE_READ_RETRY
} from './retry.js';
import { createSecretMasker } from './secrets.js';
import { POSTMAN_ENDPOINT_PROFILES } from './postman/base-urls.js';
import { AccessTokenProvider } from './postman/token-provider.js';

const DEFAULT_BIFROST_BASE_URL = POSTMAN_ENDPOINT_PROFILES.prod.bifrostBaseUrl;
const BIFROST_PROXY_PATH = '/ws/proxy';
const DEFAULT_OBSERVABILITY_BASE_URL = POSTMAN_ENDPOINT_PROFILES.prod.observabilityBaseUrl;
const DEFAULT_OBSERVABILITY_ENV = POSTMAN_ENDPOINT_PROFILES.prod.observabilityEnv;
const MAX_DISCOVERED_SERVICE_PAGES = 100;
const MAX_PROVIDER_SERVICE_PAGES = 100;

export interface CanonicalServiceIdentity {
  serviceId: number;
  serviceName: string;
  clusterName: string | null;
  projectName: string;
  providerServiceId?: string;
}

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
  /** Present on integrated/linked services when the catalog returns them. */
  collectionId?: string | null;
  workspaceId?: string | null;
  environmentId?: string | null;
  gitRepositoryUrl?: string | null;
  canonicalIdentity?: CanonicalServiceIdentity;
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

function normalizeRepoUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

async function mutateOnceThenReconcile<T>(options: {
  findExisting: () => Promise<T | null>;
  mutate: () => Promise<T>;
}): Promise<T> {
  const existing = await options.findExisting();
  if (existing !== null) {
    return existing;
  }

  try {
    return await options.mutate();
  } catch (error) {
    if (!isAmbiguousMutationFailure(error)) {
      throw error;
    }
    const adopted = await options.findExisting();
    if (adopted !== null) {
      return adopted;
    }
    throw error;
  }
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
   * x-entity-team-id is ONLY included when teamId is present (explicit input /
   * POSTMAN_TEAM_ID). Non-org-mode tokens must OMIT it so Bifrost resolves team
   * from the access token. Team is never inferred from PMAK.
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
    operation = 'api-catalog request',
    allowAuthReplay = false
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
      if (allowAuthReplay && isExpiredAuthError(response.status, bodyText) && this.tokenProvider.canRefresh()) {
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
    operation = 'Insights request',
    allowAuthReplay = false
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
      if (allowAuthReplay && isExpiredAuthError(response.status, text) && this.tokenProvider.canRefresh()) {
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

  private throwAkitaFailure(
    status: number,
    errorText: string,
    operation: string,
    path: string
  ): never {
    const httpErr = new HttpError({
      method: 'POST',
      url: `bifrost:akita:${path}`,
      status,
      statusText: status >= 500 ? 'Error' : 'Client Error',
      responseBody: errorText
    });
    const advised = adviseFromHttpError(httpErr, this.adviceContext(operation));
    throw advised ?? httpErr;
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
      SAFE_READ_RETRY
    );
  }

  /** List discovered + integrated services for exact link reconciliation. */
  async listServicesForReconcile(): Promise<DiscoveredService[]> {
    return retry(
      async () => {
        const allItems: DiscoveredService[] = [];
        let cursor: string | null = null;
        const seenCursors = new Set<string>();
        for (let page = 0; page < MAX_DISCOVERED_SERVICE_PAGES; page += 1) {
          const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
          const data: DiscoveredServicesResponse = await this.proxyRequest<DiscoveredServicesResponse>(
            'GET',
            `/api/v1/onboarding/discovered-services${query}`,
            {},
            'service link reconciliation'
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
      SAFE_READ_RETRY
    );
  }

  private async findPreparedCollection(serviceId: number, workspaceId: string): Promise<string | null> {
    const services = await this.listServicesForReconcile();
    const match = services.find(
      (service) =>
        service.id === serviceId &&
        Boolean(service.collectionId) &&
        service.workspaceId === workspaceId
    );
    return match?.collectionId ? String(match.collectionId) : null;
  }

  private async findGitLink(params: OnboardGitParams): Promise<true | null> {
    const services = await this.listServicesForReconcile();
    const match = services.find((service) => {
      if (service.id !== params.serviceId) return false;
      if (service.workspaceId !== params.workspaceId) return false;
      if (service.environmentId !== params.environmentId) return false;
      if (!service.gitRepositoryUrl) return false;
      return normalizeRepoUrl(service.gitRepositoryUrl) === normalizeRepoUrl(params.gitRepositoryUrl);
    });
    return match ? true : null;
  }

  async prepareCollection(serviceId: number, workspaceId: string): Promise<string> {
    return mutateOnceThenReconcile({
      findExisting: () => this.findPreparedCollection(serviceId, workspaceId),
      mutate: async () => {
        const data = await this.proxyRequest<{ id: string }>(
          'POST',
          '/api/v1/onboarding/prepare-collection',
          { service_id: String(serviceId), workspace_id: workspaceId },
          'collection preparation',
          false
        );
        if (!data?.id) {
          throw new Error('prepare-collection succeeded without a collection id');
        }
        return data.id;
      }
    });
  }

  async onboardGit(params: OnboardGitParams): Promise<void> {
    await mutateOnceThenReconcile({
      findExisting: () => this.findGitLink(params),
      mutate: async () => {
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
          'git onboarding',
          false
        );
        return true as const;
      }
    });
  }

  private async listProviderServices(): Promise<Array<{
    id: string;
    name: string;
    workspace_id?: string;
    system_env?: string;
    status?: string;
  }>> {
    const allServices: Array<{
      id: string;
      name: string;
      workspace_id?: string;
      system_env?: string;
      status?: string;
    }> = [];
    let page = 1;
    const pageSize = 100;

    for (let pageCount = 0; pageCount < MAX_PROVIDER_SERVICE_PAGES; pageCount += 1) {
      const result = await this.akitaProxyRequest<{
        services?: Array<{
          id: string;
          name: string;
          workspace_id?: string;
          system_env?: string;
          status?: string;
        }>;
        total?: number;
      }>(
        'GET',
        `/v2/api-catalog/services?populate_endpoints=false&populate_discovery_metadata=true&page=${page}&page_size=${pageSize}`,
        {},
        'provider service resolution'
      );
      if (!result.ok || !result.data) {
        this.throwAkitaFailure(
          result.status,
          result.errorText,
          'provider service resolution',
          'GET /v2/api-catalog/services'
        );
      }
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

    return allServices;
  }

  async resolveProviderServiceId(
    projectName: string,
    clusterName?: string
  ): Promise<string | null> {
    const allServices = await retry(
      async () => this.listProviderServices(),
      SAFE_READ_RETRY
    );

    if (clusterName) {
      const fullName = `${clusterName}/${projectName}`;
      const exactMatch = allServices.find((s) => s.name === fullName);
      return exactMatch?.id || null;
    }

    const finalSegmentMatches = allServices.filter(
      (s) => getFinalServiceSegment(s.name) === projectName
    );
    if (finalSegmentMatches.length > 1) {
      throw new Error(
        `Ambiguous Insights provider service "${projectName}": multiple final-segment matches ` +
          `(${finalSegmentMatches.map((s) => s.name).join(', ')}). ` +
          'Provide cluster-name to select the canonical service identity.'
      );
    }
    if (finalSegmentMatches.length === 1) return finalSegmentMatches[0].id;

    const bracketedMatches = allServices.filter(
      (s) => getFinalServiceSegment(s.name).includes(`[${projectName}]`)
    );
    if (bracketedMatches.length > 1) {
      throw new Error(
        `Ambiguous Insights provider service "${projectName}": multiple bracketed matches. ` +
          'Provide cluster-name to select the canonical service identity.'
      );
    }
    return bracketedMatches[0]?.id || null;
  }

  private async findAcknowledgedOnboarding(
    providerServiceId: string,
    workspaceId: string,
    systemEnvironmentId: string
  ): Promise<true | null> {
    const services = await this.listProviderServices();
    const match = services.find(
      (service) =>
        service.id === providerServiceId &&
        service.workspace_id === workspaceId &&
        service.system_env === systemEnvironmentId &&
        (service.status === 'onboarded' || service.status === 'integrated' || Boolean(service.workspace_id))
    );
    return match ? true : null;
  }

  async acknowledgeOnboarding(
    providerServiceId: string,
    workspaceId: string,
    systemEnvironmentId: string
  ): Promise<void> {
    await mutateOnceThenReconcile({
      findExisting: () =>
        this.findAcknowledgedOnboarding(providerServiceId, workspaceId, systemEnvironmentId),
      mutate: async () => {
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
          'Insights onboarding acknowledgment',
          false
        );
        if (!result.ok) {
          this.throwAkitaFailure(
            result.status,
            result.errorText,
            'Insights onboarding acknowledgment',
            'POST /v2/api-catalog/services/onboard'
          );
        }
        return true as const;
      }
    });
  }

  private async findWorkspaceAcknowledged(workspaceId: string): Promise<true | null> {
    const result = await retry(
      async () => {
        const response = await this.akitaProxyRequest<{ onboarding_acknowledged?: boolean }>(
          'GET',
          `/v2/workspaces/${workspaceId}/onboarding/acknowledge`,
          {},
          'workspace onboarding acknowledgment status'
        );
        if (!response.ok) {
          this.throwAkitaFailure(
            response.status,
            response.errorText,
            'workspace onboarding acknowledgment status',
            `GET /v2/workspaces/${workspaceId}/onboarding/acknowledge`
          );
        }
        return response;
      },
      SAFE_READ_RETRY
    );
    return result.data?.onboarding_acknowledged ? true : null;
  }

  async acknowledgeWorkspace(workspaceId: string): Promise<void> {
    await mutateOnceThenReconcile({
      findExisting: () => this.findWorkspaceAcknowledged(workspaceId),
      mutate: async () => {
        const result = await this.akitaProxyRequest<unknown>(
          'POST',
          `/v2/workspaces/${workspaceId}/onboarding/acknowledge`,
          {},
          'workspace onboarding acknowledgment',
          false
        );
        if (!result.ok) {
          this.throwAkitaFailure(
            result.status,
            result.errorText,
            'workspace onboarding acknowledgment',
            `POST /v2/workspaces/${workspaceId}/onboarding/acknowledge`
          );
        }
        return true as const;
      }
    });
  }

  private async findApplication(
    workspaceId: string,
    systemEnv: string,
    expectedServiceId?: string
  ): Promise<{ application_id: string; service_id: string } | null> {
    const response = await this.fetchFn(
      `${this.observabilityBaseUrl}/v2/agent/api-catalog/workspaces/${workspaceId}/applications`,
      {
        method: 'GET',
        headers: {
          'x-api-key': this.apiKey,
          'x-postman-env': this.observabilityEnv,
          'Content-Type': 'application/json',
        },
      },
    );
    if (!response.ok) {
      const httpErr = await HttpError.fromResponse(response, {
        method: 'GET',
        url: `observability:listApplications(${workspaceId})`,
        secretValues: this.secretValues,
      });
      const advised = adviseFromHttpError(httpErr, this.adviceContext('application binding lookup'));
      throw advised ?? httpErr;
    }
    const data = (await response.json()) as {
      applications?: Array<{ application_id?: string; service_id?: string; system_env?: string }>;
    };
    const matches = (data.applications || []).filter(
      (app) =>
        app.application_id &&
        app.service_id &&
        app.system_env === systemEnv &&
        (!expectedServiceId || app.service_id === expectedServiceId)
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple application bindings match workspace ${workspaceId}, system environment ${systemEnv}, ` +
          `and service ${expectedServiceId || '(unspecified)'}`
      );
    }
    const match = matches[0];
    if (!match?.application_id || !match.service_id) {
      return null;
    }
    return {
      application_id: String(match.application_id),
      service_id: String(match.service_id),
    };
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
    expectedServiceId?: string,
  ): Promise<{ application_id: string; service_id: string }> {
    return mutateOnceThenReconcile({
      findExisting: () => retry(
        () => this.findApplication(workspaceId, systemEnv, expectedServiceId),
        SAFE_READ_RETRY
      ),
      mutate: async () => {
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
        const created = await response.json() as { application_id: string; service_id: string };
        if (expectedServiceId && created.service_id !== expectedServiceId) {
          throw new Error(
            `Application binding credential/scope mismatch: expected service ${expectedServiceId}, received ${created.service_id}`
          );
        }
        return created;
      }
    });
  }

  async getTeamVerificationToken(workspaceId: string): Promise<string | null> {
    const result = await retry(
      async () => {
        const page = await this.akitaProxyRequest<{ team_verification_token?: string }>(
          'GET',
          `/v2/workspaces/${workspaceId}/team-verification-token`,
          {},
          'team verification token retrieval'
        );
        if (!page.ok && (page.status === 408 || page.status === 429 || page.status >= 500)) {
          throw new HttpError({
            method: 'GET',
            url: `bifrost:akita:GET /v2/workspaces/${workspaceId}/team-verification-token`,
            status: page.status,
            statusText: 'Error',
            responseBody: page.errorText
          });
        }
        return page;
      },
      SAFE_READ_RETRY
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

export function buildCanonicalServiceIdentity(
  service: Pick<DiscoveredService, 'id' | 'name'>,
  projectName: string,
  clusterName?: string,
  providerServiceId?: string
): CanonicalServiceIdentity {
  const derivedCluster =
    clusterName ||
    (service.name.includes('/')
      ? service.name.slice(0, service.name.lastIndexOf('/'))
      : null);
  return {
    serviceId: service.id,
    serviceName: service.name,
    clusterName: derivedCluster,
    projectName,
    ...(providerServiceId ? { providerServiceId } : {})
  };
}

export function findDiscoveredService(
  services: DiscoveredService[],
  projectName: string,
  clusterName?: string
): DiscoveredService | undefined {
  if (clusterName) {
    const fullName = `${clusterName}/${projectName}`;
    const match = services.find((s) => s.name === fullName);
    if (match) {
      match.canonicalIdentity = buildCanonicalServiceIdentity(match, projectName, clusterName);
    }
    return match;
  }

  const finalSegmentMatches = services.filter(
    (service) => getFinalServiceSegment(service.name) === projectName
  );
  if (finalSegmentMatches.length > 1) {
    throw new Error(
      `Ambiguous discovered service "${projectName}": multiple final-segment matches ` +
        `(${finalSegmentMatches.map((s) => s.name).join(', ')}). ` +
        'cluster-name is required to select the canonical service identity.'
    );
  }
  if (finalSegmentMatches.length === 1) {
    const match = finalSegmentMatches[0];
    match.canonicalIdentity = buildCanonicalServiceIdentity(match, projectName);
    return match;
  }

  const bracketedMatches = services.filter(
    (service) => getFinalServiceSegment(service.name).includes(`[${projectName}]`)
  );
  if (bracketedMatches.length > 1) {
    throw new Error(
      `Ambiguous discovered service "${projectName}": multiple bracketed matches. ` +
        'cluster-name is required to select the canonical service identity.'
    );
  }
  if (bracketedMatches.length === 1) {
    const match = bracketedMatches[0];
    match.canonicalIdentity = buildCanonicalServiceIdentity(match, projectName);
    return match;
  }
  return undefined;
}

function getFinalServiceSegment(serviceName: string): string {
  const lastSlash = serviceName.lastIndexOf('/');
  return lastSlash === -1 ? serviceName : serviceName.slice(lastSlash + 1);
}
