import * as core from '@actions/core';
import {
  BifrostCatalogClient,
  buildCanonicalServiceIdentity,
  findDiscoveredService,
  type CanonicalServiceIdentity
} from './lib/bifrost-client.js';
import {
  getMemoizedSessionIdentity,
  runCredentialPreflight,
  type CredentialIdentity,
  type PreflightMode
} from './lib/credential-identity.js';
import {
  parsePostmanRegion,
  parsePostmanStack,
  resolvePostmanEndpointProfile,
  type PostmanRegion,
  type PostmanStack
} from './lib/postman/base-urls.js';
import { sleep } from './lib/retry.js';
import { createSecretMasker } from './lib/secrets.js';
import { AccessTokenProvider, mintAccessTokenIfNeeded } from './lib/postman/token-provider.js';
import { getInput } from './lib/input.js';
import {
  BRANCH_DECISION_ENV,
  parseChannelRules,
  resolveBranchIdentity,
  resolveEffectiveBranchDecision,
  serializeBranchDecision,
  type BranchDecision,
  type BranchStrategy
} from './lib/repo-branch-decision.js';
import { createTelemetryContext } from '@postman-cse/automation-telemetry-core';
import { resolveActionVersion } from './action-version.js';

export { getInput } from './lib/input.js';

const POLL_TIMEOUT_MIN = 10;
const POLL_TIMEOUT_MAX = 600;
const POLL_TIMEOUT_DEFAULT = 120;
const POLL_INTERVAL_MIN = 2;
const POLL_INTERVAL_MAX = 60;
const POLL_INTERVAL_DEFAULT = 10;

const PROD_ENDPOINTS = resolvePostmanEndpointProfile('prod');
export const DEFAULT_POSTMAN_API_BASE = PROD_ENDPOINTS.apiBaseUrl;
export const DEFAULT_POSTMAN_BIFROST_BASE = PROD_ENDPOINTS.bifrostBaseUrl;
export const DEFAULT_POSTMAN_IAPUB_BASE = PROD_ENDPOINTS.iapubBaseUrl;
export const DEFAULT_POSTMAN_OBSERVABILITY_BASE = PROD_ENDPOINTS.observabilityBaseUrl;

export type ServiceNotFoundPolicy = 'fail' | 'warn';

export function parsePreflightMode(value: string | undefined): PreflightMode {
  const normalized = String(value || 'enforce').trim().toLowerCase();
  if (normalized === 'enforce' || normalized === 'warn') {
    return normalized;
  }
  throw new Error(
    `Unsupported credential-preflight "${value}". Supported values: enforce, warn`
  );
}

export function parseServiceNotFoundPolicy(value: string | undefined): ServiceNotFoundPolicy {
  const normalized = String(value || 'fail').trim().toLowerCase();
  if (normalized === 'fail' || normalized === 'warn') {
    return normalized;
  }
  throw new Error(
    `Unsupported service-not-found-policy "${value}". Supported values: fail, warn`
  );
}

export function parseCreateApiKey(value: string | undefined): boolean {
  const normalized = String(value || 'false').trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false' || normalized === '') {
    return false;
  }
  throw new Error(
    `Unsupported create-api-key "${value}". Supported values: true, false`
  );
}

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

/**
 * @deprecated Team selection must come from explicit postman-team-id /
 * POSTMAN_TEAM_ID only. Kept for diagnostic callers; not used to set
 * x-entity-team-id.
 */
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
  credentialPreflight: PreflightMode;
  /** Explicit opt-in for durable Bifrost API-key creation. Default false. */
  createApiKey: boolean;
  /** Full linking fails when the service is absent unless set to warn. */
  serviceNotFoundPolicy: ServiceNotFoundPolicy;
  pollTimeoutSeconds: number;
  pollIntervalSeconds: number;
  postmanRegion: PostmanRegion;
  postmanStack: PostmanStack;
  postmanApiBase: string;
  postmanBifrostBase: string;
  postmanIapubBase: string;
  postmanObservabilityBase: string;
  postmanObservabilityEnv: string;
  branchStrategy?: string;
  canonicalBranch?: string;
  channels?: string;
}

export interface OnboardingResult {
  discoveredServiceId: number;
  discoveredServiceName: string;
  collectionId: string;
  applicationId: string;
  verificationToken: string | null;
  status: 'success' | 'not-found' | 'error';
  canonicalIdentity?: CanonicalServiceIdentity;
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
  const get = (name: string, fallback = ''): string => getInput(name, env) || fallback;

  const projectName = get('project-name');
  if (!projectName) throw new Error('project-name is required');

  const postmanAccessToken = get('postman-access-token');
  const postmanApiKey = get('postman-api-key');
  if (!postmanAccessToken && !postmanApiKey) {
    throw new Error(
      'postman-access-token is required (or provide a service-account postman-api-key so the action can mint one).'
    );
  }
  // Read postman-team-id from action input, falling back to POSTMAN_TEAM_ID env.
  // Never infer team from PMAK /teams or /me.
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
  const postmanRegion = parsePostmanRegion(get('postman-region'));
  const postmanStack = parsePostmanStack(get('postman-stack'));
  const endpointProfile = resolvePostmanEndpointProfile(postmanStack, postmanRegion);

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
    credentialPreflight: parsePreflightMode(get('credential-preflight', 'enforce')),
    createApiKey: parseCreateApiKey(get('create-api-key', 'false')),
    serviceNotFoundPolicy: parseServiceNotFoundPolicy(get('service-not-found-policy', 'fail')),
    pollTimeoutSeconds: clamp(rawTimeout, POLL_TIMEOUT_MIN, POLL_TIMEOUT_MAX, POLL_TIMEOUT_DEFAULT),
    pollIntervalSeconds: clamp(rawInterval, POLL_INTERVAL_MIN, POLL_INTERVAL_MAX, POLL_INTERVAL_DEFAULT),
    postmanRegion,
    postmanStack,
    postmanApiBase: endpointProfile.apiBaseUrl,
    postmanBifrostBase: endpointProfile.bifrostBaseUrl,
    postmanIapubBase: endpointProfile.iapubBaseUrl,
    postmanObservabilityBase: endpointProfile.observabilityBaseUrl,
    postmanObservabilityEnv: endpointProfile.observabilityEnv,
    branchStrategy: get('branch-strategy', 'legacy'),
    canonicalBranch: get('canonical-branch', ''),
    channels: get('channels', ''),
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
  const policy = inputs.serviceNotFoundPolicy ?? 'fail';

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
    const message =
      `Service "${inputs.projectName}" not found in discovered services after ${inputs.pollTimeoutSeconds}s`;
    if (policy === 'warn') {
      reporter.warning(message);
      return {
        discoveredServiceId: 0,
        discoveredServiceName: '',
        collectionId: '',
        applicationId: '',
        verificationToken: null,
        status: 'not-found',
      };
    }
    throw new Error(`${message}. Full linking requires a discovered service (service-not-found-policy=fail).`);
  }

  const canonicalBase = match.canonicalIdentity
    ?? buildCanonicalServiceIdentity(match, inputs.projectName, inputs.clusterName || undefined);

  // Resolve the complete canonical identity before the first write. Full linking
  // cannot safely start when Catalog and Insights do not identify the same service.
  const providerServiceId = await client.resolveProviderServiceId(
    inputs.projectName,
    inputs.clusterName || undefined,
  );
  if (!providerServiceId) {
    throw new Error(
      `Insights provider service "${canonicalBase.serviceName}" was not found. Full linking requires one exact canonical service identity.`
    );
  }
  const sysEnvId = inputs.systemEnvironmentId || match.systemEnvironmentId || '';
  if (!sysEnvId) {
    throw new Error(
      `No system environment id is available for "${canonicalBase.serviceName}"; refusing partial linking writes.`
    );
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

  reporter.info(`Acknowledging Insights onboarding for ${providerServiceId}...`);
  await client.acknowledgeOnboarding(providerServiceId, inputs.workspaceId, sysEnvId);
  reporter.info(`Insights acknowledged: ${providerServiceId}`);

  reporter.info(`Creating application binding for workspace ${inputs.workspaceId} with system_env ${sysEnvId}...`);
  const appResult = await client.createApplication(inputs.workspaceId, sysEnvId, providerServiceId);
  reporter.info(`Application binding created: ${appResult.application_id} for service ${appResult.service_id}`);

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
    applicationId: appResult.application_id,
    verificationToken,
    status: 'success',
    canonicalIdentity: {
      ...canonicalBase,
      ...(providerServiceId ? { providerServiceId } : {})
    }
  };
}

/**
 * Validate the provided API key and resolve the explicit team id.
 *
 * Durable API-key creation is opt-in via `create-api-key=true`. Ordinary reruns
 * never create timestamp-named orphan keys. Team id comes only from explicit
 * `postman-team-id` / `POSTMAN_TEAM_ID` — never from PMAK /teams or /me inference.
 */
export async function resolveApiKeyAndTeamId(
  inputs: ActionInputs,
  client: BifrostCatalogClient,
  reporter: Reporter = core
): Promise<{ apiKey: string; teamId: string; pmakIdentity?: CredentialIdentity }> {
  let apiKey = inputs.postmanApiKey;
  const teamId = inputs.postmanTeamId;
  let keyValid = false;
  let pmakIdentity: CredentialIdentity | undefined;

  const apiBase = inputs.postmanApiBase || DEFAULT_POSTMAN_API_BASE;
  const createApiKey = inputs.createApiKey === true;

  if (apiKey) {
    const result = await validateApiKey(apiKey, apiBase);
    keyValid = result.valid;
    if (keyValid) {
      // Reused by the credential preflight so it never issues a second /me probe.
      pmakIdentity = { source: 'pmak/me', teamId: result.teamId };
    } else {
      reporter.warning('Provided postman-api-key is invalid or expired.');
    }
  }

  if (!keyValid) {
    if (!createApiKey) {
      if (apiKey) {
        throw new Error(
          'postman-api-key is invalid or expired. Provide a valid key, or set create-api-key=true to opt in to durable Bifrost API-key creation.'
        );
      }
      throw new Error(
        'postman-api-key is required for application binding. Provide a valid key, or set create-api-key=true to opt in to durable Bifrost API-key creation.'
      );
    }

    reporter.info('create-api-key=true: generating a durable Postman API key via Bifrost identity service...');
    const keyName = `insights-onboarding-${inputs.projectName}`;
    apiKey = await client.createApiKey(keyName);
    reporter.setSecret(apiKey);
    client.setApiKey(apiKey);
    const createdIdentity = await validateApiKey(apiKey, apiBase);
    if (!createdIdentity.valid) {
      throw new Error('The explicitly created postman-api-key could not be validated; refusing linking writes.');
    }
    pmakIdentity = { source: 'pmak/me', teamId: createdIdentity.teamId };
    reporter.info(`New API key created successfully (${keyName}).`);
  }

  if (teamId) {
    reporter.info(`Using explicit postman-team-id for Bifrost headers: ${teamId}`);
  } else {
    reporter.info(
      'No postman-team-id / POSTMAN_TEAM_ID provided; omitting x-entity-team-id so Bifrost resolves team from the access token.'
    );
  }

  return { apiKey, teamId, pmakIdentity };
}

/**
 * Proactive credential preflight seam shared by the action and CLI entrypoints.
 *
 * The PMAK identity is reused from validateApiKey's /me result (via resolveApiKeyAndTeamId),
 * so the preflight itself never issues a /me probe. A rejected or absent postman-api-key
 * yields no PMAK identity, so only access-token identity can be validated until
 * an explicitly requested key has been created and validated.
 */
export async function runCredentialPreflightForInputs(
  inputs: ActionInputs,
  pmak: CredentialIdentity | undefined,
  reporter: Reporter,
  fetchImpl?: typeof fetch,
  liveAccessToken?: string
): Promise<void> {
  const accessToken = liveAccessToken ?? inputs.postmanAccessToken;
  await runCredentialPreflight({
    apiBaseUrl: inputs.postmanApiBase || DEFAULT_POSTMAN_API_BASE,
    iapubBaseUrl: inputs.postmanIapubBase || DEFAULT_POSTMAN_IAPUB_BASE,
    pmak,
    postmanAccessToken: accessToken,
    explicitTeamId: inputs.postmanTeamId || undefined,
    mode: inputs.credentialPreflight,
    mask: createSecretMasker([inputs.postmanApiKey, accessToken]),
    log: reporter,
    fetchImpl
  });
}

export function createInsightsTokenProvider(
  inputs: ActionInputs,
  reporter: Reporter,
  apiKey = inputs.postmanApiKey
): AccessTokenProvider {
  return new AccessTokenProvider({
    accessToken: inputs.postmanAccessToken,
    apiKey,
    apiBaseUrl: inputs.postmanApiBase || DEFAULT_POSTMAN_API_BASE,
    onToken: (token) => reporter.setSecret(token)
  });
}

export function createInsightsBifrostClient(
  inputs: ActionInputs,
  tokenProvider: AccessTokenProvider,
  teamId: string,
  apiKey: string
): BifrostCatalogClient {
  return new BifrostCatalogClient({
    tokenProvider,
    accessToken: tokenProvider.current(),
    teamId,
    apiKey,
    bifrostBaseUrl: inputs.postmanBifrostBase,
    observabilityBaseUrl: inputs.postmanObservabilityBase,
    observabilityEnv: inputs.postmanObservabilityEnv
  });
}

export function decideBranchTier(
  inputs: Pick<ActionInputs, 'branchStrategy' | 'canonicalBranch' | 'channels'>,
  env: NodeJS.ProcessEnv = process.env
): import('./lib/repo-branch-decision.js').BranchDecision {
  return resolveEffectiveBranchDecision(
    {
      strategy: (inputs.branchStrategy as BranchStrategy) ?? 'legacy',
      identity: resolveBranchIdentity(env, { defaultBranch: inputs.canonicalBranch }),
      canonicalBranch: inputs.canonicalBranch,
      channels: parseChannelRules(inputs.channels)
    },
    env
  );
}

export async function runAction(): Promise<void> {
  const inputs = resolveInputs();
  const planned = createPlannedOutputs(inputs);
  for (const [key, value] of Object.entries(planned)) {
    core.setOutput(key, value);
  }

  // Branch-aware sync: decide BEFORE any credential validation or mint.
  const branchDecision = decideBranchTier(inputs);
  if (branchDecision.tier === 'gated') {
    core.info(`branch-aware sync: gated run (${branchDecision.reason}) — skipping insights linking, zero writes`);
    core.setOutput('status', 'skipped');
    core.setOutput('sync-status', 'skipped-branch-gate');
    core.setOutput('branch-decision', serializeBranchDecision(branchDecision));
    process.env[BRANCH_DECISION_ENV] = serializeBranchDecision(branchDecision);
    return;
  }
  if (branchDecision.tier !== 'legacy') {
    core.info(`branch-aware sync: tier=${branchDecision.tier} (${branchDecision.reason})`);
    process.env[BRANCH_DECISION_ENV] = serializeBranchDecision(branchDecision);
    core.setOutput('branch-decision', serializeBranchDecision(branchDecision));
    core.setOutput('sync-status', 'synced');
  }

  // PMAK-only runs: eagerly mint the short-lived access token from the service
  // -account PMAK so the Bifrost binding surface works exactly as when
  // postman-access-token is supplied. Mirrors bootstrap's runAction. A failed
  // mint warns with a live-probed diagnosis (personal key vs permission gap vs
  // invalid key); the run then fails on the first Bifrost call with that
  // context already logged.
  const mintHolder = {
    postmanAccessToken: inputs.postmanAccessToken,
    postmanApiKey: inputs.postmanApiKey,
    postmanApiBase: inputs.postmanApiBase
  };
  await mintAccessTokenIfNeeded(mintHolder, core, (secret) => core.setSecret(secret));
  inputs.postmanAccessToken = mintHolder.postmanAccessToken;

  if (inputs.postmanAccessToken) core.setSecret(inputs.postmanAccessToken);
  if (inputs.postmanApiKey) core.setSecret(inputs.postmanApiKey);
  if (inputs.githubToken) core.setSecret(inputs.githubToken);

  const tokenProvider = createInsightsTokenProvider(inputs, core);
  // Preliminary client uses only the explicit team id (never PMAK-inferred).
  const preliminaryClient = createInsightsBifrostClient(
    inputs,
    tokenProvider,
    inputs.postmanTeamId,
    inputs.postmanApiKey
  );

  const telemetry = createTelemetryContext({ action: 'postman-insights-onboarding-action', actionVersion: resolveActionVersion(), logger: core });
  telemetry.setTeamId(inputs.postmanTeamId);

  let result: OnboardingResult;
  try {
    // Validate credentials and scope before any durable API-key or linking write.
    // When create-api-key is false, resolveApiKeyAndTeamId only validates.
    // When true and the key is missing/invalid, creation happens after preflight
    // would ideally run — but preflight needs a valid PMAK identity when present.
    // Order: validate provided key -> preflight with access token -> optional create.
    let apiKey = inputs.postmanApiKey;
    let pmakIdentity: CredentialIdentity | undefined;
    const apiBase = inputs.postmanApiBase || DEFAULT_POSTMAN_API_BASE;

    if (apiKey) {
      const validated = await validateApiKey(apiKey, apiBase);
      if (validated.valid) {
        pmakIdentity = { source: 'pmak/me', teamId: validated.teamId };
      } else if (!inputs.createApiKey) {
        throw new Error(
          'postman-api-key is invalid or expired. Provide a valid key, or set create-api-key=true to opt in to durable Bifrost API-key creation.'
        );
      } else {
        core.warning('Provided postman-api-key is invalid or expired.');
      }
    } else if (!inputs.createApiKey) {
      throw new Error(
        'postman-api-key is required for application binding. Provide a valid key, or set create-api-key=true to opt in to durable Bifrost API-key creation.'
      );
    }

    await runCredentialPreflightForInputs(
      inputs,
      pmakIdentity,
      core,
      undefined,
      tokenProvider.current()
    );

    const resolved = await resolveApiKeyAndTeamId(inputs, preliminaryClient, core);
    apiKey = resolved.apiKey;
    const teamId = resolved.teamId;

    if (resolved.pmakIdentity?.teamId !== pmakIdentity?.teamId) {
      await runCredentialPreflightForInputs(
        inputs,
        resolved.pmakIdentity,
        core,
        undefined,
        tokenProvider.current()
      );
    }

    const activeTokenProvider =
      apiKey !== inputs.postmanApiKey
        ? new AccessTokenProvider({
            accessToken: tokenProvider.current(),
            apiKey,
            apiBaseUrl: inputs.postmanApiBase || DEFAULT_POSTMAN_API_BASE,
            onToken: (token) => core.setSecret(token)
          })
        : tokenProvider;

    const client = createInsightsBifrostClient(inputs, activeTokenProvider, teamId, apiKey);

    result = await runOnboarding(inputs, client, sleep, core);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    core.setOutput('status', 'error');
    core.setFailed(`Insights onboarding failed: ${message}`);
    telemetry.setAccountType(getMemoizedSessionIdentity()?.consumerType);
    telemetry.emitCompletion('failure');
    return;
  }

  core.setOutput('discovered-service-id', String(result.discoveredServiceId));
  core.setOutput('discovered-service-name', result.discoveredServiceName);
  core.setOutput('collection-id', result.collectionId);
  core.setOutput('application-id', result.applicationId);
  core.setOutput('verification-token', result.verificationToken || '');
  core.setOutput('status', result.status);

  telemetry.setAccountType(getMemoizedSessionIdentity()?.consumerType);
  if (result.status === 'not-found') {
    core.warning('Insights onboarding skipped: service not found in discovered list');
    telemetry.emitCompletion('failure');
  } else {
    core.info(`Insights onboarding succeeded: ${result.discoveredServiceName} -> workspace ${inputs.workspaceId}`);
    telemetry.emitCompletion('success');
  }
}
