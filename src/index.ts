import * as core from '@actions/core';
import { BifrostCatalogClient, findDiscoveredService } from './lib/bifrost-client.js';
import {
  parsePostmanStack,
  resolvePostmanEndpointProfile,
  type PostmanStack
} from './lib/postman/base-urls.js';
import { sleep } from './lib/retry.js';

const POLL_TIMEOUT_MIN = 10;
const POLL_TIMEOUT_MAX = 600;
const POLL_TIMEOUT_DEFAULT = 120;
const POLL_INTERVAL_MIN = 2;
const POLL_INTERVAL_MAX = 60;
const POLL_INTERVAL_DEFAULT = 10;

const PROD_ENDPOINTS = resolvePostmanEndpointProfile('prod');
export const DEFAULT_POSTMAN_API_BASE = PROD_ENDPOINTS.apiBaseUrl;
export const DEFAULT_POSTMAN_BIFROST_BASE = PROD_ENDPOINTS.bifrostBaseUrl;
export const DEFAULT_POSTMAN_OBSERVABILITY_BASE = PROD_ENDPOINTS.observabilityBaseUrl;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export async function validateApiKey(
  apiKey: string,
  apiBase: string = DEFAULT_POSTMAN_API_BASE
): Promise<{ valid: boolean; teamId?: string }> {
  const res = await fetch(`${trimTrailingSlash(apiBase)}/me`, {
    method: 'GET',
    headers: { 'x-api-key': apiKey },
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return { valid: false };
    }
    throw new Error(`API key validation failed with unexpected status ${res.status}`);
  }
  const data = (await res.json()) as { user?: { teamId?: number | string } };
  const teamId = data?.user?.teamId ? String(data.user.teamId) : undefined;
  return { valid: true, teamId };
}

export async function getTeams(
  apiKey: string,
  apiBase: string = DEFAULT_POSTMAN_API_BASE
): Promise<Array<{ id: number; name: string; organizationId?: number }>> {
  try {
    const res = await fetch(`${trimTrailingSlash(apiBase)}/teams`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id: number; name: string; handle?: string; organizationId?: number }> };
    return (data?.data ?? [])
      .filter(t => t?.id && t?.name)
      .map(t => ({
        id: Number(t.id),
        name: String(t.name),
        ...(t.organizationId != null ? { organizationId: Number(t.organizationId) } : {})
      }));
  } catch {
    return [];
  }
}

export interface ActionInputs {
  projectName: string;
  workspaceId: string;
  environmentId: string;
  systemEnvironmentId: string;
  clusterName: string;
  repoUrl: string;
  postmanAccessToken: string;
  postmanApiKey: string;
  postmanTeamId: string;
  githubToken: string;
  pollTimeoutSeconds: number;
  pollIntervalSeconds: number;
  postmanStack: PostmanStack;
  postmanApiBase: string;
  postmanBifrostBase: string;
  postmanObservabilityBase: string;
  postmanObservabilityEnv: string;
}

export interface OnboardingResult {
  discoveredServiceId: number;
  discoveredServiceName: string;
  collectionId: string;
  applicationId: string;
  verificationToken: string | null;
  status: 'success' | 'not-found' | 'error';
}

export interface Reporter {
  info(message: string): void;
  warning(message: string): void;
  setSecret(value: string): void;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  const parsed = Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function resolveInputs(
  env: Record<string, string | undefined> = process.env
): ActionInputs {
  const get = (name: string, fallback = ''): string =>
    env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`]?.trim() || fallback;

  const projectName = get('project-name');
  if (!projectName) throw new Error('project-name is required');

  const postmanAccessToken = get('postman-access-token');
  if (!postmanAccessToken) throw new Error('postman-access-token is required');

  const postmanApiKey = get('postman-api-key');
  // Read postman-team-id from action input, falling back to POSTMAN_TEAM_ID env
  const postmanTeamId = get('postman-team-id') || env.POSTMAN_TEAM_ID?.trim() || '';

  const workspaceId = get('workspace-id') || env.POSTMAN_WORKSPACE_ID?.trim() || '';
  if (!workspaceId) {
    throw new Error(
      'workspace-id is required. Provide it as an input, or set the POSTMAN_WORKSPACE_ID environment variable.'
    );
  }

  const environmentId = get('environment-id') || env.POSTMAN_ENVIRONMENT_ID?.trim() || '';
  if (!environmentId) {
    throw new Error(
      'environment-id is required. Provide it as an input, or set the POSTMAN_ENVIRONMENT_ID environment variable.'
    );
  }

  // Derive repo URL from CI environment (provider-agnostic)
  const detectedRepoUrl =
    (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`
      : '') ||
    env.CI_PROJECT_URL ||
    env.BITBUCKET_GIT_HTTP_ORIGIN ||
    env.BUILD_REPOSITORY_URI ||
    '';
  const repoUrl = get('repo-url', detectedRepoUrl);

  const rawTimeout = parseInt(get('poll-timeout-seconds', String(POLL_TIMEOUT_DEFAULT)), 10);
  const rawInterval = parseInt(get('poll-interval-seconds', String(POLL_INTERVAL_DEFAULT)), 10);
  const postmanStack = parsePostmanStack(get('postman-stack'));
  const endpointProfile = resolvePostmanEndpointProfile(postmanStack);

  return {
    projectName,
    workspaceId,
    environmentId,
    systemEnvironmentId: get('system-environment-id', ''),
    clusterName: get('cluster-name', ''),
    repoUrl,
    postmanAccessToken,
    postmanApiKey,
    postmanTeamId,
    githubToken: get('github-token', env.GITHUB_TOKEN || ''),
    pollTimeoutSeconds: clamp(rawTimeout, POLL_TIMEOUT_MIN, POLL_TIMEOUT_MAX, POLL_TIMEOUT_DEFAULT),
    pollIntervalSeconds: clamp(rawInterval, POLL_INTERVAL_MIN, POLL_INTERVAL_MAX, POLL_INTERVAL_DEFAULT),
    postmanStack,
    postmanApiBase: endpointProfile.apiBaseUrl,
    postmanBifrostBase: endpointProfile.bifrostBaseUrl,
    postmanObservabilityBase: endpointProfile.observabilityBaseUrl,
    postmanObservabilityEnv: endpointProfile.observabilityEnv,
  };
}

export function createPlannedOutputs(inputs: ActionInputs): Record<string, string> {
  return {
    'discovered-service-id': '',
    'discovered-service-name': inputs.clusterName
      ? `${inputs.clusterName}/${inputs.projectName}`
      : inputs.projectName,
    'collection-id': '',
    'application-id': '',
    'verification-token': '',
    'status': 'pending',
  };
}

export async function runOnboarding(
  inputs: ActionInputs,
  client: BifrostCatalogClient,
  sleepFn: (ms: number) => Promise<void> = sleep,
  reporter: Reporter = core
): Promise<OnboardingResult> {
  const timeoutMs = inputs.pollTimeoutSeconds * 1000;
  const intervalMs = inputs.pollIntervalSeconds * 1000;
  const startTime = Date.now();

  reporter.info(`Looking for discovered service matching "${inputs.clusterName ? `${inputs.clusterName}/` : ''}${inputs.projectName}"...`);

  let match = undefined;

  while (Date.now() - startTime < timeoutMs) {
    const discovered = await client.listDiscoveredServices();
    match = findDiscoveredService(discovered, inputs.projectName, inputs.clusterName || undefined);

    if (match) {
      reporter.info(`Found discovered service: ${match.name} (id: ${match.id})`);
      break;
    }

    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    reporter.info(`Service not yet discovered (${elapsedSec}s elapsed, timeout ${inputs.pollTimeoutSeconds}s). Waiting ${inputs.pollIntervalSeconds}s...`);
    await sleepFn(intervalMs);
  }

  if (!match) {
    reporter.warning(`Service "${inputs.projectName}" not found in discovered services after ${inputs.pollTimeoutSeconds}s`);
    return {
      discoveredServiceId: 0,
      discoveredServiceName: '',
      collectionId: '',
      applicationId: '',
      verificationToken: null,
      status: 'not-found',
    };
  }

  reporter.info(`Preparing collection for service ${match.id} in workspace ${inputs.workspaceId}...`);
  const collectionId = await client.prepareCollection(match.id, inputs.workspaceId);
  reporter.info(`Collection prepared: ${collectionId}`);

  const repoUrl = inputs.repoUrl;
  const isGitHub = /^https?:\/\/(www\.)?github\.com\//i.test(repoUrl);
  if (isGitHub) {
    reporter.info(`Onboarding git integration: ${repoUrl}`);
    await client.onboardGit({
      serviceId: match.id,
      workspaceId: inputs.workspaceId,
      environmentId: inputs.environmentId,
      gitRepositoryUrl: repoUrl,
      gitApiKey: inputs.githubToken || undefined,
    });
    reporter.info(`Git onboarding complete for ${match.name}`);
  } else {
    reporter.info(`Skipping git onboarding for non-GitHub repo: ${repoUrl}`);
  }

  const providerServiceId = await client.resolveProviderServiceId(
    inputs.projectName,
    inputs.clusterName || undefined,
  );
  let applicationId = '';
  if (providerServiceId) {
    const sysEnvId = inputs.systemEnvironmentId || match.systemEnvironmentId || '';
    if (sysEnvId) {
      reporter.info(`Acknowledging Insights onboarding for ${providerServiceId}...`);
      await client.acknowledgeOnboarding(providerServiceId, inputs.workspaceId, sysEnvId);
      reporter.info(`Insights acknowledged: ${providerServiceId}`);

      reporter.info(`Creating application binding for workspace ${inputs.workspaceId} with system_env ${sysEnvId}...`);
      const appResult = await client.createApplication(inputs.workspaceId, sysEnvId);
      applicationId = appResult.application_id;
      reporter.info(`Application binding created: ${appResult.application_id} for service ${appResult.service_id}`);
    } else {
      reporter.warning('No systemEnvironmentId available; skipping Insights acknowledgment and application binding');
    }
  } else {
    reporter.warning('Could not resolve Akita provider service ID; skipping acknowledgment and application binding');
  }

  reporter.info(`Acknowledging workspace onboarding for ${inputs.workspaceId}...`);
  await client.acknowledgeWorkspace(inputs.workspaceId);
  reporter.info('Workspace onboarding acknowledged');

  reporter.info('Retrieving team verification token...');
  const verificationToken = await client.getTeamVerificationToken(inputs.workspaceId);
  if (verificationToken) {
    reporter.info('Team verification token retrieved');
    reporter.setSecret(verificationToken);
  } else {
    reporter.warning('Failed to retrieve team verification token');
  }

  return {
    discoveredServiceId: match.id,
    discoveredServiceName: match.name,
    collectionId,
    applicationId,
    verificationToken,
    status: 'success',
  };
}

export async function resolveApiKeyAndTeamId(
  inputs: ActionInputs,
  client: BifrostCatalogClient,
  reporter: Reporter = core
): Promise<{ apiKey: string; teamId: string }> {
  let apiKey = inputs.postmanApiKey;
  const teamId = inputs.postmanTeamId;
  let keyValid = false;

  const apiBase = inputs.postmanApiBase || DEFAULT_POSTMAN_API_BASE;

  if (apiKey) {
    const result = await validateApiKey(apiKey, apiBase);
    keyValid = result.valid;
    if (!keyValid) {
      reporter.warning('Provided postman-api-key is invalid or expired.');
    }
  }

  if (!keyValid) {
    reporter.info('Generating a new Postman API key via Bifrost identity service...');
    const keyName = `insights-onboarding-action-${Date.now()}`;
    apiKey = await client.createApiKey(keyName);
    reporter.setSecret(apiKey);
    client.setApiKey(apiKey);
    reporter.info('New API key created successfully.');
  }

  // Auto-detect org-mode and derive team ID when not explicitly provided
  let resolvedTeamId = teamId;
  if (!resolvedTeamId && apiKey) {
    try {
      const teams = await getTeams(apiKey, apiBase);
      if (teams.length > 1 && teams.every(t => t.organizationId == null)) {
        reporter.warning(
          'GET /teams returned multiple teams but none include organizationId. ' +
          'Org-mode auto-detection may be degraded due to an upstream API change. ' +
          'Set postman-team-id explicitly if Bifrost calls fail.'
        );
      }
      const isOrgMode = teams.some(t => t.organizationId != null);
      if (isOrgMode) {
        if (teams.length === 1) {
          resolvedTeamId = String(teams[0].id);
          reporter.info(
            `Org-mode account detected. Using sub-team ${teams[0].id} (${teams[0].name ?? 'unknown'}) for Bifrost calls.`
          );
        } else {
          const meResult = await validateApiKey(apiKey, apiBase);
          const meTeamId = meResult.teamId ? parseInt(meResult.teamId, 10) : NaN;
          if (!Number.isNaN(meTeamId) && teams.some(t => t.id === meTeamId)) {
            resolvedTeamId = String(meTeamId);
            reporter.info(
              `Org-mode account detected. Using sub-team ${meTeamId} (from /me) for Bifrost calls.`
            );
          }
        }
      }
    } catch {
      // Non-fatal: if detection fails, teamId stays empty (header omitted) which is safe
    }
  }

  if (resolvedTeamId) {
    reporter.info(`Using postman-team-id for Bifrost headers: ${resolvedTeamId}`);
  } else {
    reporter.info('No postman-team-id resolved; omitting x-entity-team-id so Bifrost resolves team from the access token.');
  }

  return { apiKey, teamId: resolvedTeamId };
}

async function runAction(): Promise<void> {
  const inputs = resolveInputs();
  const planned = createPlannedOutputs(inputs);
  for (const [key, value] of Object.entries(planned)) {
    core.setOutput(key, value);
  }

  core.setSecret(inputs.postmanAccessToken);
  if (inputs.postmanApiKey) core.setSecret(inputs.postmanApiKey);
  if (inputs.githubToken) core.setSecret(inputs.githubToken);

  const preliminaryClient = new BifrostCatalogClient({
    accessToken: inputs.postmanAccessToken,
    teamId: inputs.postmanTeamId,
    apiKey: inputs.postmanApiKey,
    bifrostBaseUrl: inputs.postmanBifrostBase,
    observabilityBaseUrl: inputs.postmanObservabilityBase,
    observabilityEnv: inputs.postmanObservabilityEnv,
  });

  const { apiKey, teamId } = await resolveApiKeyAndTeamId(inputs, preliminaryClient, core);

  const client = new BifrostCatalogClient({
    accessToken: inputs.postmanAccessToken,
    teamId,
    apiKey,
    bifrostBaseUrl: inputs.postmanBifrostBase,
    observabilityBaseUrl: inputs.postmanObservabilityBase,
    observabilityEnv: inputs.postmanObservabilityEnv,
  });

  let result: import('./index.js').OnboardingResult;
  try {
    result = await runOnboarding(inputs, client, sleep, core);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    core.setOutput('status', 'error');
    core.setFailed(`Insights onboarding failed: ${message}`);
    return;
  }

  core.setOutput('discovered-service-id', String(result.discoveredServiceId));
  core.setOutput('discovered-service-name', result.discoveredServiceName);
  core.setOutput('collection-id', result.collectionId);
  core.setOutput('application-id', result.applicationId);
  core.setOutput('verification-token', result.verificationToken || '');
  core.setOutput('status', result.status);

  if (result.status === 'not-found') {
    core.warning('Insights onboarding skipped: service not found in discovered list');
  } else {
    core.info(`Insights onboarding succeeded: ${result.discoveredServiceName} -> workspace ${inputs.workspaceId}`);
  }
}

runAction().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  core.setOutput('status', 'error');
  core.setFailed(message);
  process.exitCode = 1;
});
