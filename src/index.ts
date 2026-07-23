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
import { createSecretMasker, toOneLine } from './lib/secrets.js';
import { AccessTokenProvider } from './lib/postman/token-provider.js';
import { getInput } from './lib/input.js';
import {
  BRANCH_DECISION_ENV,
  parseChannelRules,
  resolveBranchIdentity,
  resolveEffectiveBranchDecision,
  serializeBranchDecision,
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

/** Collapse control/newline characters so CI log/error lines stay single-line. */
function collapseControlChars(value: string): string {
  return toOneLine(value);
}

function underlyingErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || 'unknown error';
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error ?? 'unknown error');
}

function formatOnboardingDiagnostic(
  value: string | number | undefined | null,
  mask: (input: string) => string
): string {
  return mask(collapseControlChars(String(value ?? '')));
}

function wrapOnboardingPhaseError(
  operation: string,
  context: string,
  remediation: string,
  error: unknown,
  mask: (input: string) => string
): Error {
  const causeText = formatOnboardingDiagnostic(underlyingErrorMessage(error), mask);
  const message = mask(
    collapseControlChars(
      `Failed to ${operation}${context ? ` ${context}` : ''}: ${causeText}. ${remediation}`
    )
  );
  return new Error(message, { cause: error instanceof Error ? error : undefined });
}

export function parsePreflightMode(value: string | undefined): PreflightMode {
  const normalized = String(value || 'enforce').trim().toLowerCase();
  if (normalized === 'enforce' || normalized === 'warn') {
    return normalized;
  }
  const sanitized = collapseControlChars(String(value ?? ''));
  throw new Error(
    collapseControlChars(
      `Unsupported credential-preflight "${sanitized}". Supported values: enforce, warn. Provide one of the supported values, then rerun.`
    )
  );
}

export function parseServiceNotFoundPolicy(value: string | undefined): ServiceNotFoundPolicy {
  const normalized = String(value || 'fail').trim().toLowerCase();
  if (normalized === 'fail' || normalized === 'warn') {
    return normalized;
  }
  const sanitized = collapseControlChars(String(value ?? ''));
  throw new Error(
    collapseControlChars(
      `Unsupported service-not-found-policy "${sanitized}". Supported values: fail, warn. Provide one of the supported values, then rerun.`
    )
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
  const sanitized = collapseControlChars(String(value ?? ''));
  throw new Error(
    collapseControlChars(
      `Unsupported create-api-key "${sanitized}". Supported values: true, false. Provide one of the supported values, then rerun.`
    )
  );
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export async function validateApiKey(
  apiKey: string,
  apiBase: string = DEFAULT_POSTMAN_API_BASE
): Promise<{ valid: boolean; teamId?: string }> {
  const mask = createSecretMasker([apiKey]);
  const meUrl = `${trimTrailingSlash(apiBase)}/me`;
  const endpointLabel = formatOnboardingDiagnostic(meUrl, mask);
  const remediation =
    'Verify the Postman API endpoint/network and that the postman-api-key is valid, then rerun.';

  let res: Response;
  try {
    res = await fetch(meUrl, {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(2000)
    });
  } catch (error) {
    throw new Error(
      mask(
        collapseControlChars(
          `API key validation failed for GET ${endpointLabel}: ${formatOnboardingDiagnostic(underlyingErrorMessage(error), mask)}. ${remediation}`
        )
      ),
      { cause: error }
    );
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return { valid: false };
    }
    throw new Error(
      mask(
        collapseControlChars(
          `API key validation failed for GET ${endpointLabel} with unexpected status ${res.status}. ${remediation}`
        )
      )
    );
  }
  let data: { user?: { teamId?: number | string; username?: unknown; email?: unknown } };
  try {
    data = (await res.json()) as { user?: { teamId?: number | string; username?: unknown; email?: unknown } };
  } catch (error) {
    throw new Error(mask(`Insights requires a human-user PMAK; GET ${endpointLabel} returned an inconclusive identity response.`), { cause: error });
  }
  const user = data?.user;
  const username = typeof user?.username === 'string' ? user.username.trim() : '';
  const email = typeof user?.email === 'string' ? user.email.trim() : '';
  if (!username && !email) {
    throw new Error('Insights requires a human-user PMAK; the supplied postman-api-key did not resolve to a human user.');
  }
  const teamId = user?.teamId ? String(user.teamId) : undefined;
  return { valid: true, teamId };
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
  env: Record<string, string | undefined> = process.env,
  allowGatedMissing = false
): ActionInputs {
  const get = (name: string, fallback = ''): string => getInput(name, env) || fallback;

  const projectName = get('project-name');
  if (!projectName) throw new Error('project-name is required');

  const postmanAccessToken = get('postman-access-token');
  const postmanApiKey = get('postman-api-key');
  // Read postman-team-id from action input, falling back to POSTMAN_TEAM_ID env.
  // Never infer team from PMAK /teams or /me.
  const postmanTeamId = get('postman-team-id') || env.POSTMAN_TEAM_ID?.trim() || '';

  const workspaceId = get('workspace-id') || env.POSTMAN_WORKSPACE_ID?.trim() || '';
  if (!allowGatedMissing && !workspaceId) {
    throw new Error(
      'workspace-id is required. Provide it as an input, or set the POSTMAN_WORKSPACE_ID environment variable.'
    );
  }

  const environmentId = get('environment-id') || env.POSTMAN_ENVIRONMENT_ID?.trim() || '';
  if (!allowGatedMissing && !environmentId) {
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

export function assertWritingInputs(inputs: Pick<ActionInputs, 'postmanAccessToken' | 'postmanApiKey' | 'workspaceId' | 'environmentId' | 'createApiKey'>): void {
  if (!inputs.postmanAccessToken || (!inputs.postmanApiKey && !inputs.createApiKey)) {
    throw new Error('Insights requires both a human-user PMAK and a human-user session access token. A session access token cannot be minted from a PMAK.');
  }
  if (!inputs.workspaceId) {
    throw new Error('workspace-id is required. Provide it as an input, or set POSTMAN_WORKSPACE_ID.');
  }
  if (!inputs.environmentId) {
    throw new Error('environment-id is required. Provide it as an input, or set POSTMAN_ENVIRONMENT_ID.');
  }
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
  const mask = createSecretMasker([
    inputs.postmanAccessToken,
    inputs.postmanApiKey,
    inputs.githubToken
  ]);
  const diag = (value: string | number | undefined | null): string =>
    formatOnboardingDiagnostic(value, mask);

  const projectLabel = diag(inputs.projectName);
  const clusterLabel = diag(inputs.clusterName);
  const workspaceLabel = diag(inputs.workspaceId);
  const environmentLabel = diag(inputs.environmentId);
  const repoLabel = diag(inputs.repoUrl);
  const canonicalTarget = inputs.clusterName
    ? `${inputs.clusterName}/${inputs.projectName}`
    : inputs.projectName;
  const canonicalLabel = diag(canonicalTarget);

  reporter.info(
    `Looking for discovered service matching "${clusterLabel ? `${clusterLabel}/` : ''}${projectLabel}"...`
  );

  let match = undefined;

  while (Date.now() - startTime < timeoutMs) {
    let discovered;
    try {
      discovered = await client.listDiscoveredServices();
    } catch (error) {
      throw wrapOnboardingPhaseError(
        'listDiscoveredServices',
        `for project "${projectLabel}"${clusterLabel ? ` cluster "${clusterLabel}"` : ''} canonical "${canonicalLabel}"`,
        'Verify the access token team scope plus project-name/cluster-name inputs, then rerun.',
        error,
        mask
      );
    }
    try {
      match = findDiscoveredService(discovered, inputs.projectName, inputs.clusterName || undefined);
    } catch (error) {
      throw wrapOnboardingPhaseError(
        'resolve discovered-service identity',
        `for project "${projectLabel}"${clusterLabel ? ` cluster "${clusterLabel}"` : ''} canonical "${canonicalLabel}" workspace ${workspaceLabel}`,
        'Provide or correct cluster-name so exactly one discovered service matches, then rerun.',
        error,
        mask
      );
    }

    if (match) {
      reporter.info(`Found discovered service: ${diag(match.name)} (id: ${diag(match.id)})`);
      break;
    }

    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    reporter.info(`Service not yet discovered (${elapsedSec}s elapsed, timeout ${inputs.pollTimeoutSeconds}s). Waiting ${inputs.pollIntervalSeconds}s...`);
    await sleepFn(intervalMs);
  }

  if (!match) {
    const message =
      `Service "${projectLabel}"${clusterLabel ? ` cluster "${clusterLabel}"` : ''} (canonical "${canonicalLabel}") not found in discovered services after ${inputs.pollTimeoutSeconds}s. Verify the access token team scope and that project-name/cluster-name match a discovered Insights service, then rerun.`;
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
    throw new Error(
      `${message} Full linking requires a discovered service (service-not-found-policy=fail).`
    );
  }

  const canonicalBase = match.canonicalIdentity
    ?? buildCanonicalServiceIdentity(match, inputs.projectName, inputs.clusterName || undefined);
  const discoveredServiceLabel = diag(match.name);
  const discoveredServiceIdLabel = diag(match.id);

  // Resolve the complete canonical identity before the first write. Full linking
  // cannot safely start when Catalog and Insights do not identify the same service.
  let providerServiceId: string | null;
  try {
    providerServiceId = await client.resolveProviderServiceId(
      inputs.projectName,
      inputs.clusterName || undefined,
    );
  } catch (error) {
    throw wrapOnboardingPhaseError(
      'resolveProviderServiceId',
      `for project "${projectLabel}"${clusterLabel ? ` cluster "${clusterLabel}"` : ''} discovered service id=${discoveredServiceIdLabel} name="${discoveredServiceLabel}"`,
      'Verify the access token team scope plus project-name/cluster-name inputs, then rerun.',
      error,
      mask
    );
  }
  if (!providerServiceId) {
    throw new Error(
      mask(
        collapseControlChars(
          `Insights provider service "${diag(canonicalBase.serviceName)}" was not found for discovered service id=${discoveredServiceIdLabel} name="${discoveredServiceLabel}" workspace ${workspaceLabel}. Full linking requires one exact canonical service identity. Verify the access token team scope plus project-name/cluster-name inputs, then rerun.`
        )
      )
    );
  }
  const providerLabel = diag(providerServiceId);
  const sysEnvId = inputs.systemEnvironmentId || match.systemEnvironmentId || '';
  if (!sysEnvId) {
    throw new Error(
      mask(
        collapseControlChars(
          `No system environment id is available for discovered service id=${discoveredServiceIdLabel} name="${discoveredServiceLabel}" (canonical "${diag(canonicalBase.serviceName)}", workspace ${workspaceLabel}); provide system-environment-id or ensure the discovered service includes one. Refusing partial linking writes.`
        )
      )
    );
  }
  const sysEnvLabel = diag(sysEnvId);

  reporter.info(
    `Preparing collection for service ${discoveredServiceIdLabel} in workspace ${workspaceLabel}...`
  );
  let collectionId: string;
  try {
    collectionId = await client.prepareCollection(match.id, inputs.workspaceId);
  } catch (error) {
    throw wrapOnboardingPhaseError(
      'prepareCollection',
      `for discovered service id=${discoveredServiceIdLabel} name="${discoveredServiceLabel}" in workspace ${workspaceLabel}`,
      `Verify workspace ${workspaceLabel} exists and the access token can edit it, then rerun.`,
      error,
      mask
    );
  }
  reporter.info(`Collection prepared: ${diag(collectionId)}`);

  const repoUrl = inputs.repoUrl;
  const isGitHub = /^https?:\/\/(www\.)?github\.com\//i.test(repoUrl);
  if (isGitHub) {
    reporter.info(`Onboarding git integration: ${repoLabel}`);
    try {
      await client.onboardGit({
        serviceId: match.id,
        workspaceId: inputs.workspaceId,
        environmentId: inputs.environmentId,
        gitRepositoryUrl: repoUrl,
        gitApiKey: inputs.githubToken || undefined,
      });
    } catch (error) {
      throw wrapOnboardingPhaseError(
        'onboardGit',
        `for discovered service id=${discoveredServiceIdLabel} repo ${repoLabel} workspace ${workspaceLabel} environment ${environmentLabel}`,
        'Verify github-token/repo ownership and remove any stale git link or target its current workspace when already linked, then rerun.',
        error,
        mask
      );
    }
    reporter.info(`Git onboarding complete for ${discoveredServiceLabel}`);
  } else {
    reporter.info(`Skipping git onboarding for non-GitHub repo: ${repoLabel}`);
  }

  reporter.info(`Acknowledging Insights onboarding for ${providerLabel}...`);
  try {
    await client.acknowledgeOnboarding(providerServiceId, inputs.workspaceId, sysEnvId);
  } catch (error) {
    throw wrapOnboardingPhaseError(
      'acknowledgeOnboarding',
      `for provider service ${providerLabel} workspace ${workspaceLabel} system-environment ${sysEnvLabel}`,
      'Use a Postman-user-identity access token for the same org and verify the provider/workspace/system-environment IDs, then rerun.',
      error,
      mask
    );
  }
  reporter.info(`Insights acknowledged: ${providerLabel}`);

  reporter.info(
    `Creating application binding for workspace ${workspaceLabel} with system_env ${sysEnvLabel}...`
  );
  let appResult: { application_id: string; service_id: string };
  try {
    appResult = await client.createApplication(inputs.workspaceId, sysEnvId, providerServiceId);
  } catch (error) {
    throw wrapOnboardingPhaseError(
      'createApplication',
      `for workspace ${workspaceLabel} system-environment ${sysEnvLabel} provider service ${providerLabel}`,
      'Verify the PMAK/access token belong to the same org/team and the workspace/system-environment IDs are correct, then rerun.',
      error,
      mask
    );
  }
  reporter.info(
    `Application binding created: ${diag(appResult.application_id)} for service ${diag(appResult.service_id)}`
  );

  reporter.info(`Acknowledging workspace onboarding for ${workspaceLabel}...`);
  try {
    await client.acknowledgeWorkspace(inputs.workspaceId);
  } catch (error) {
    throw wrapOnboardingPhaseError(
      'acknowledgeWorkspace',
      `for workspace ${workspaceLabel}`,
      'Verify workspace/team access and rerun.',
      error,
      mask
    );
  }
  reporter.info('Workspace onboarding acknowledged');

  reporter.info('Retrieving team verification token...');
  let verificationToken: string | null;
  try {
    verificationToken = await client.getTeamVerificationToken(inputs.workspaceId);
  } catch (error) {
    throw wrapOnboardingPhaseError(
      'getTeamVerificationToken',
      `for workspace ${workspaceLabel}`,
      'Verify workspace/team access and rerun.',
      error,
      mask
    );
  }
  if (verificationToken) {
    reporter.info('Team verification token retrieved');
    reporter.setSecret(verificationToken);
  } else {
    reporter.warning(
      `Team verification token unavailable for workspace ${workspaceLabel}: linking already completed, but the endpoint returned no token. Verify workspace/team access and rerun if a verification token is required.`
    );
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
  const mask = createSecretMasker([
    inputs.postmanAccessToken,
    inputs.postmanApiKey,
    inputs.githubToken
  ]);
  const diag = (value: string | number | undefined | null): string =>
    formatOnboardingDiagnostic(value, mask);
  const projectLabel = diag(inputs.projectName);
  const teamIdLabel = diag(teamId);
  const meEndpointLabel = diag(`${trimTrailingSlash(apiBase)}/me`);

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
    const keyNameLabel = diag(keyName);
    try {
      apiKey = await client.createApiKey(keyName);
    } catch (error) {
      throw wrapOnboardingPhaseError(
        'createApiKey',
        `for key name "${keyNameLabel}" project "${projectLabel}"`,
        'Verify Bifrost identity access for durable API-key creation and that create-api-key is intentional, then rerun.',
        error,
        mask
      );
    }
    reporter.setSecret(apiKey);
    client.setApiKey(apiKey);
    const createdIdentity = await validateApiKey(apiKey, apiBase);
    if (!createdIdentity.valid) {
      throw new Error(
        mask(
          collapseControlChars(
            `The explicitly created postman-api-key "${keyNameLabel}" for project "${projectLabel}" could not be validated via GET ${meEndpointLabel}; refusing linking writes. Verify the Postman API endpoint/network and Bifrost-created key, then rerun.`
          )
        )
      );
    }
    pmakIdentity = { source: 'pmak/me', teamId: createdIdentity.teamId };
    reporter.info(`New API key created successfully (${keyNameLabel}).`);
  }

  if (teamId) {
    reporter.info(`Using explicit postman-team-id for Bifrost headers: ${teamIdLabel}`);
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
  _reporter: Reporter
): AccessTokenProvider {
  void _reporter;
  return new AccessTokenProvider({
    accessToken: inputs.postmanAccessToken
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
  const inputs = resolveInputs(process.env, true);
  const planned = createPlannedOutputs(inputs);
  for (const [key, value] of Object.entries(planned)) {
    core.setOutput(key, value);
  }

  const logMask = () =>
    createSecretMasker([
      inputs.postmanAccessToken,
      inputs.postmanApiKey,
      inputs.githubToken
    ]);
  const logDiag = (value: string | number | undefined | null): string =>
    formatOnboardingDiagnostic(value, logMask());

  // Branch-aware sync: decide BEFORE credential validation or writes.
  const branchDecision = decideBranchTier(inputs);
  if (branchDecision.tier !== 'legacy' && branchDecision.tier !== 'canonical') {
    core.info(
      `branch-aware sync: ${logDiag(branchDecision.tier)} run (${logDiag(branchDecision.reason)}) — skipping insights linking, zero writes`
    );
    core.setOutput('status', 'skipped');
    core.setOutput('sync-status', 'skipped-branch-gate');
    core.setOutput('branch-decision', serializeBranchDecision(branchDecision));
    process.env[BRANCH_DECISION_ENV] = serializeBranchDecision(branchDecision);
    return;
  }
  assertWritingInputs(inputs);
  if (branchDecision.tier !== 'legacy') {
    core.info(
      `branch-aware sync: tier=${logDiag(branchDecision.tier)} (${logDiag(branchDecision.reason)})`
    );
    process.env[BRANCH_DECISION_ENV] = serializeBranchDecision(branchDecision);
    core.setOutput('branch-decision', serializeBranchDecision(branchDecision));
    core.setOutput('sync-status', 'synced');
  }

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

    const activeTokenProvider = tokenProvider;

    const client = createInsightsBifrostClient(inputs, activeTokenProvider, teamId, apiKey);

    result = await runOnboarding(inputs, client, sleep, core);
  } catch (error: unknown) {
    const message = logDiag(error instanceof Error ? error.message : String(error));
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
    const projectLabel = logDiag(inputs.projectName);
    const canonicalLabel = logDiag(
      inputs.clusterName ? `${inputs.clusterName}/${inputs.projectName}` : inputs.projectName
    );
    const workspaceLabel = logDiag(inputs.workspaceId);
    core.warning(
      `Insights onboarding skipped: service "${projectLabel}" (canonical "${canonicalLabel}") not found in discovered list for workspace ${workspaceLabel}. Verify the access token team scope and that project-name/cluster-name match a discovered Insights service, then rerun.`
    );
    telemetry.emitCompletion('failure');
  } else {
    core.info(
      `Insights onboarding succeeded: ${logDiag(result.discoveredServiceName)} -> workspace ${logDiag(inputs.workspaceId)}`
    );
    telemetry.emitCompletion('success');
  }
}
