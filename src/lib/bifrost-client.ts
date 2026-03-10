import { HttpError } from './http-error.js';
import { retry } from './retry.js';
import type { SecretMasker } from './secrets.js';

const BIFROST_BASE = 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy';

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
  gitApiKey: string;
}

export interface BifrostClientOptions {
  accessToken: string;
  teamId: string;
  fetchFn?: typeof globalThis.fetch;
  maskSecret?: SecretMasker;
}

export class BifrostCatalogClient {
  private readonly accessToken: string;
  private readonly teamId: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly secretValues: string[];

  constructor(options: BifrostClientOptions) {
    this.accessToken = options.accessToken;
    this.teamId = options.teamId;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.secretValues = [options.accessToken];
  }

  private headers(): Record<string, string> {
    return {
      'x-access-token': this.accessToken,
      'x-entity-team-id': this.teamId,
      'Content-Type': 'application/json'
    };
  }

  private async proxyRequest<T>(
    method: string,
    path: string,
    body: unknown = {}
  ): Promise<T> {
    const response = await this.fetchFn(BIFROST_BASE, {
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

  async listDiscoveredServices(): Promise<DiscoveredService[]> {
    return retry(
      async () => {
        const data = await this.proxyRequest<DiscoveredServicesResponse>(
          'GET',
          '/api/v1/onboarding/discovered-services?status=discovered'
        );
        return data.items || [];
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
        await this.proxyRequest<{ message?: string }>(
          'POST',
          '/api/v1/onboarding/git',
          {
            via_integrations: false,
            git_service_name: 'github',
            workspace_id: params.workspaceId,
            git_repository_url: params.gitRepositoryUrl,
            git_api_key: params.gitApiKey,
            service_id: params.serviceId,
            environment_id: params.environmentId
          }
        );
      },
      { maxAttempts: 2, delayMs: 3000 }
    );
  }
}

export function findDiscoveredService(
  services: DiscoveredService[],
  projectName: string,
  clusterName?: string
): DiscoveredService | undefined {
  if (clusterName) {
    const fullName = `${clusterName}/${projectName}`;
    const exact = services.find((s) => s.name === fullName);
    if (exact) return exact;
  }
  return services.find((s) => s.name.endsWith(`/${projectName}`));
}
