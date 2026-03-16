import * as core from '@actions/core';
import { BifrostCatalogClient, findDiscoveredService } from './lib/bifrost-client.js';
import { sleep } from './lib/retry.js';
import { createSecretMasker } from './lib/secrets.js';

const POLL_TIMEOUT_MIN = 10;
const POLL_TIMEOUT_MAX = 600;
const POLL_TIMEOUT_DEFAULT = 120;
const POLL_INTERVAL_MIN = 2;
const POLL_INTERVAL_MAX = 60;
const POLL_INTERVAL_DEFAULT = 10;

export async function deriveTeamId(apiKey: string): Promise<string | undefined> {
  try {
    const res = await fetch('https://api.getpostman.com/me', {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { user?: { teamId?: number | string } };
    if (data?.user?.teamId) return String(data.user.teamId);
  } catch {
    // derivation is best-effort
  }
  return undefined;
}

export async function validateApiKey(apiKey: string): Promise<{ valid: boolean; teamId?: string }> {
  const res = await fetch('https://api.getpostman.com/me', {
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

export async function deriveTeamIdFromSession(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch('https://iapub.postman.co/api/sessions/current', {
      method: 'GET',
      headers: { 'x-access-token': accessToken },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      session?: { identity?: { team?: number | string } };
    };
    if (data?.session?.identity?.team) return String(data.session.identity.team);
  } catch {
    // fallback is best-effort
  }
  return undefined;
}

export interface ActionInputs {
  projectName: string;
  workspaceId: string;
  environmentId: string;
  systemEnvironmentId: string;
  clusterName: string;
  gitOwner: string;
  gitRepositoryName: string;
  postmanAccessToken: string;
  postmanApiKey: string;
  postmanTeamId: string;
  githubToken: string;
  pollTimeoutSeconds: number;
  pollIntervalSeconds: number;
}

export interface OnboardingResult {
  discoveredServiceId: number;
  discoveredServiceName: string;
  collectionId: string;
  applicationId: string;
  verificationToken: string | null;
  status: 'success' | 'not-found' | 'error';
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

  const workspaceId = get('workspace-id');
  if (!workspaceId) throw new Error('workspace-id is required');

  const environmentId = get('environment-id');
  if (!environmentId) throw new Error('environment-id is required');

  const repoOwner = (env.GITHUB_REPOSITORY || '').split('/')[0] || '';
  const gitOwner = get('git-owner', repoOwner);
  const gitRepositoryName = get('git-repository-name', projectName);

  const rawTimeout = parseInt(get('poll-timeout-seconds', String(POLL_TIMEOUT_DEFAULT)), 10);
  const rawInterval = parseInt(get('poll-interval-seconds', String(POLL_INTERVAL_DEFAULT)), 10);

  return {
    projectName,
    workspaceId,
    environmentId,
    systemEnvironmentId: get('system-environment-id', ''),
    clusterName: get('cluster-name', ''),
    gitOwner,
    gitRepositoryName,
    postmanAccessToken,
    postmanApiKey,
    postmanTeamId,
    githubToken: get('github-token', env.GITHUB_TOKEN || ''),
    pollTimeoutSeconds: clamp(rawTimeout, POLL_TIMEOUT_MIN, POLL_TIMEOUT_MAX, POLL_TIMEOUT_DEFAULT),
    pollIntervalSeconds: clamp(rawInterval, POLL_INTERVAL_MIN, POLL_INTERVAL_MAX, POLL_INTERVAL_DEFAULT),
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
  sleepFn: (ms: number) => Promise<void> = sleep
): Promise<OnboardingResult> {
  const timeoutMs = inputs.pollTimeoutSeconds * 1000;
  const intervalMs = inputs.pollIntervalSeconds * 1000;
  const startTime = Date.now();

  core.info(`Looking for discovered service matching "${inputs.clusterName ? `${inputs.clusterName}/` : ''}${inputs.projectName}"...`);

  let match = undefined;

  while (Date.now() - startTime < timeoutMs) {
    const discovered = await client.listDiscoveredServices();
    match = findDiscoveredService(discovered, inputs.projectName, inputs.clusterName || undefined);

    if (match) {
      core.info(`Found discovered service: ${match.name} (id: ${match.id})`);
      break;
    }

    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    core.info(`Service not yet discovered (${elapsedSec}s elapsed, timeout ${inputs.pollTimeoutSeconds}s). Waiting ${inputs.pollIntervalSeconds}s...`);
    await sleepFn(intervalMs);
  }

  if (!match) {
    core.warning(`Service "${inputs.projectName}" not found in discovered services after ${inputs.pollTimeoutSeconds}s`);
    return {
      discoveredServiceId: 0,
      discoveredServiceName: '',
      collectionId: '',
      applicationId: '',
      verificationToken: null,
      status: 'not-found',
    };
  }

  core.info(`Preparing collection for service ${match.id} in workspace ${inputs.workspaceId}...`);
  const collectionId = await client.prepareCollection(match.id, inputs.workspaceId);
  core.info(`Collection prepared: ${collectionId}`);

  const repoUrl = `https://github.com/${inputs.gitOwner}/${inputs.gitRepositoryName}`;
  core.info(`Onboarding git integration: ${repoUrl}`);
  await client.onboardGit({
    serviceId: match.id,
    workspaceId: inputs.workspaceId,
    environmentId: inputs.environmentId,
    gitRepositoryUrl: repoUrl,
    gitApiKey: inputs.githubToken || undefined,
  });
  core.info(`Git onboarding complete for ${match.name}`);

  const providerServiceId = await client.resolveProviderServiceId(
    inputs.projectName,
    inputs.clusterName || undefined,
  );
  let applicationId = '';
  if (providerServiceId) {
    const sysEnvId = inputs.systemEnvironmentId || match.systemEnvironmentId || '';
    if (sysEnvId) {
      core.info(`Acknowledging Insights onboarding for ${providerServiceId}...`);
      await client.acknowledgeOnboarding(providerServiceId, inputs.workspaceId, sysEnvId);
      core.info(`Insights acknowledged: ${providerServiceId}`);

      core.info(`Creating application binding for workspace ${inputs.workspaceId} with system_env ${sysEnvId}...`);
      const appResult = await client.createApplication(inputs.workspaceId, sysEnvId);
      applicationId = appResult.application_id;
      core.info(`Application binding created: ${appResult.application_id} for service ${appResult.service_id}`);
    } else {
      core.warning('No systemEnvironmentId available; skipping Insights acknowledgment and application binding');
    }
  } else {
    core.warning('Could not resolve Akita provider service ID; skipping acknowledgment and application binding');
  }

  core.info(`Acknowledging workspace onboarding for ${inputs.workspaceId}...`);
  await client.acknowledgeWorkspace(inputs.workspaceId);
  core.info('Workspace onboarding acknowledged');

  core.info('Retrieving team verification token...');
  const verificationToken = await client.getTeamVerificationToken(inputs.workspaceId);
  if (verificationToken) {
    core.info('Team verification token retrieved');
    core.setSecret(verificationToken);
  } else {
    core.warning('Failed to retrieve team verification token');
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
): Promise<{ apiKey: string; teamId: string }> {
  let apiKey = inputs.postmanApiKey;
  const teamId = inputs.postmanTeamId;
  let keyValid = false;

  if (apiKey) {
    try {
      const result = await validateApiKey(apiKey);
      keyValid = result.valid;
      if (!keyValid) {
        core.warning('Provided postman-api-key is invalid or expired.');
      }
    } catch (error: unknown) {
      // Network errors or unexpected status codes: rethrow instead of treating as invalid key
      throw error;
    }
  }

  if (!keyValid) {
    core.info('Generating a new Postman API key via Bifrost identity service...');
    const keyName = `insights-onboarding-action-${Date.now()}`;
    apiKey = await client.createApiKey(keyName);
    core.setSecret(apiKey);
    client.setApiKey(apiKey);
    core.info('New API key created successfully.');
  }

  if (teamId) {
    core.info(`Using explicit postman-team-id for Bifrost headers: ${teamId}`);
  } else {
    core.info('No explicit postman-team-id provided; omitting x-entity-team-id so Bifrost resolves team from the access token.');
  }

  return { apiKey, teamId };
}

async function runAction(): Promise<void> {
  const inputs = resolveInputs();
  const planned = createPlannedOutputs(inputs);
  for (const [key, value] of Object.entries(planned)) {
    core.setOutput(key, value);
  }

  const maskSecret = createSecretMasker([
    inputs.postmanAccessToken,
    inputs.postmanApiKey,
    inputs.githubToken,
  ].filter(Boolean));

  core.setSecret(inputs.postmanAccessToken);
  if (inputs.postmanApiKey) core.setSecret(inputs.postmanApiKey);
  if (inputs.githubToken) core.setSecret(inputs.githubToken);

  const preliminaryClient = new BifrostCatalogClient({
    accessToken: inputs.postmanAccessToken,
    teamId: inputs.postmanTeamId,
    apiKey: inputs.postmanApiKey,
    maskSecret,
  });

  const { apiKey, teamId } = await resolveApiKeyAndTeamId(inputs, preliminaryClient);

  const client = new BifrostCatalogClient({
    accessToken: inputs.postmanAccessToken,
    teamId,
    apiKey,
    maskSecret,
  });

  let result: import('./index.js').OnboardingResult;
  try {
    result = await runOnboarding(inputs, client);
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
