import { HttpError } from './http-error.js';
import { retry } from './retry.js';
import { POSTMAN_ENDPOINT_PROFILES } from './postman/base-urls.js';

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

export class BifrostCatalogClient {
  private readonly accessToken: string;
  private readonly teamId: string;
  private apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly secretValues: string[];
  private readonly bifrostProxyUrl: string;
  private readonly observabilityBaseUrl: string;
  private readonly observabilityEnv: string;

  constructor(options: BifrostClientOptions) {
    this.accessToken = options.accessToken;
    this.teamId = options.teamId;
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.secretValues = [options.accessToken, options.apiKey].filter(Boolean);
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

  /**
   * Build Bifrost proxy headers.
   * x-entity-team-id is ONLY included when teamId is present (org-mode tokens).
   * Non-org-mode tokens must OMIT it so Bifrost resolves team from the access token.
   */
  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'x-access-token': this.accessToken,
      'Content-Type': 'application/json',
    };
    if (this.teamId) {
      h['x-entity-team-id'] = this.teamId;
    }
    return h;
  }

  private async proxyRequest<T>(
    method: string,
    path: string,
    body: unknown = {}
  ): Promise<T> {
    const response = await this.fetchFn(this.bifrostProxyUrl, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        service: 'api-catalog',
        method,
        path,
        body
      })
    });

    if (!response.ok) {
      throw await HttpError.fromResponse(response, {
        method: 'POST',
        url: `bifrost:api-catalog:${method} ${path}`,
        secretValues: this.secretValues
      });
    }

    const data = (await response.json()) as T & { error?: { message?: string; code?: string } };
    if (data && typeof data === 'object' && 'error' in data && (data as Record<string, unknown>).error) {
      const errObj = (data as Record<string, { message?: string; code?: string }>).error;
      throw new Error(`api-catalog error: ${errObj?.message || errObj?.code || 'unknown'}`);
    }

    return data;
  }

  private async akitaProxyRequest<T>(
    method: string,
    path: string,
    body: unknown = {}
  ): Promise<{ ok: boolean; status: number; data: T | null; errorText: string }> {
    const response = await this.fetchFn(this.bifrostProxyUrl, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        service: 'akita',
        method,
        path,
        body
      })
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, status: response.status, data: null, errorText: text };
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
            `/api/v1/onboarding/discovered-services?status=discovered${cursorParam}`
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
          { service_id: String(serviceId), workspace_id: workspaceId }
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
          body
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
        `/v2/api-catalog/services?status=discovered&populate_endpoints=false&populate_discovery_metadata=true&page=${page}&page_size=${pageSize}`
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

    const fullName = clusterName ? `${clusterName}/${projectName}` : projectName;
    // When clusterName is provided, require exact match only (no suffix fallback)
    const exactMatch = allServices.find((s) => s.name === fullName);
    if (exactMatch) return exactMatch.id;
    if (clusterName) return null;
    // Without clusterName, fall back to suffix match
    const suffixMatch = allServices.find((s) => s.name.endsWith(`/${projectName}`));
    return suffixMatch?.id || null;
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
      }
    );
    if (!result.ok) {
      throw new Error(`Insights acknowledge failed: ${result.status} ${result.errorText}`);
    }
  }

  async acknowledgeWorkspace(workspaceId: string): Promise<void> {
    const result = await this.akitaProxyRequest<unknown>(
      'POST',
      `/v2/workspaces/${workspaceId}/onboarding/acknowledge`
    );
    if (!result.ok) {
      throw new Error(`Workspace acknowledge failed: ${result.status} ${result.errorText}`);
    }
  }

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
      throw await HttpError.fromResponse(response, {
        method: 'POST',
        url: `observability:createApplication(${workspaceId})`,
        secretValues: this.secretValues,
      });
    }
    return response.json() as Promise<{ application_id: string; service_id: string }>;
  }

  async getTeamVerificationToken(workspaceId: string): Promise<string | null> {
    const result = await this.akitaProxyRequest<{ team_verification_token?: string }>(
      'GET',
      `/v2/workspaces/${workspaceId}/team-verification-token`
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
      throw await HttpError.fromResponse(response, {
        method: 'POST',
        url: 'bifrost:identity:POST /api/keys',
        secretValues: this.secretValues,
      });
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
    // When clusterName is provided, require exact match only (no suffix fallback)
    return services.find((s) => s.name === fullName);
  }
  return services.find((s) => s.name.endsWith(`/${projectName}`));
}
