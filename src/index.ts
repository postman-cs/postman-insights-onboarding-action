import * as core from '@actions/core';
import { BifrostCatalogClient, findDiscoveredService } from './lib/bifrost-client.js';
import { sleep } from './lib/retry.js';
import { createSecretMasker } from './lib/secrets.js';

export interface ActionInputs {
  projectName: string;
  workspaceId: string;
  environmentId: string;
  clusterName: string;
  gitOwner: string;
  gitRepositoryName: string;
  postmanAccessToken: string;
  postmanTeamId: string;
  githubToken: string;
  pollTimeoutSeconds: number;
  pollIntervalSeconds: number;
}

export interface OnboardingResult {
  discoveredServiceId: number;
  discoveredServiceName: string;
  collectionId: string;
  status: 'success' | 'not-found' | 'error';
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

  const postmanTeamId = get('postman-team-id');
  if (!postmanTeamId) throw new Error('postman-team-id is required');

  const workspaceId = get('workspace-id');
  if (!workspaceId) throw new Error('workspace-id is required');

  const environmentId = get('environment-id');
  if (!environmentId) throw new Error('environment-id is required');

  const repoOwner = (env.GITHUB_REPOSITORY || '').split('/')[0] || '';
  const gitOwner = get('git-owner', repoOwner);
  const gitRepositoryName = get('git-repository-name', projectName);

  return {
    projectName,
    workspaceId,
    environmentId,
    clusterName: get('cluster-name', ''),
    gitOwner,
    gitRepositoryName,
    postmanAccessToken,
    postmanTeamId,
    githubToken: get('github-token', env.GITHUB_TOKEN || ''),
    pollTimeoutSeconds: Math.max(0, parseInt(get('poll-timeout-seconds', '120'), 10) || 120),
    pollIntervalSeconds: Math.max(1, parseInt(get('poll-interval-seconds', '10'), 10) || 10),
  };
}

export function createPlannedOutputs(inputs: ActionInputs): Record<string, string> {
  return {
    'discovered-service-id': '',
    'discovered-service-name': inputs.clusterName
      ? `${inputs.clusterName}/${inputs.projectName}`
      : inputs.projectName,
    'collection-id': '',
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
    gitApiKey: inputs.githubToken,
  });
  core.info(`Git onboarding complete for ${match.name}`);

  // Acknowledge with Akita backend so the agent stops returning 403
  const providerServiceId = await client.resolveProviderServiceId(
    inputs.projectName,
    inputs.clusterName || undefined,
  );
  if (providerServiceId) {
    const sysEnvId = match.systemEnvironmentId || '';
    if (sysEnvId) {
      core.info(`Acknowledging Insights onboarding for ${providerServiceId}...`);
      await client.acknowledgeOnboarding(providerServiceId, inputs.workspaceId, sysEnvId);
      core.info(`Insights acknowledged: ${providerServiceId}`);
    } else {
      core.warning('No systemEnvironmentId available; skipping Insights acknowledgment');
    }
  } else {
    core.warning('Could not resolve Akita provider service ID; skipping acknowledgment');
  }

  return {
    discoveredServiceId: match.id,
    discoveredServiceName: match.name,
    collectionId,
    status: 'success',
  };
}

async function runAction(): Promise<void> {
  const inputs = resolveInputs();
  const maskSecret = createSecretMasker([
    inputs.postmanAccessToken,
    inputs.githubToken,
  ]);

  core.setSecret(inputs.postmanAccessToken);
  if (inputs.githubToken) core.setSecret(inputs.githubToken);

  const planned = createPlannedOutputs(inputs);
  for (const [key, value] of Object.entries(planned)) {
    core.setOutput(key, value);
  }

  const client = new BifrostCatalogClient({
    accessToken: inputs.postmanAccessToken,
    teamId: inputs.postmanTeamId,
    maskSecret,
  });

  const result = await runOnboarding(inputs, client);

  core.setOutput('discovered-service-id', String(result.discoveredServiceId));
  core.setOutput('discovered-service-name', result.discoveredServiceName);
  core.setOutput('collection-id', result.collectionId);
  core.setOutput('status', result.status);

  if (result.status === 'not-found') {
    core.warning('Insights onboarding skipped: service not found in discovered list');
  } else if (result.status === 'error') {
    core.setFailed('Insights onboarding failed');
  } else {
    core.info(`Insights onboarding succeeded: ${result.discoveredServiceName} -> workspace ${inputs.workspaceId}`);
  }
}

runAction().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
  process.exitCode = 1;
});
