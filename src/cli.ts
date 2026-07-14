import { randomUUID } from 'node:crypto';
import { realpathSync, readFileSync } from 'node:fs';
import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AccessTokenProvider, mintAccessTokenIfNeeded } from './lib/postman/token-provider.js';
import {
  createInsightsBifrostClient,
  createInsightsTokenProvider,
  DEFAULT_POSTMAN_API_BASE,
  resolveApiKeyAndTeamId,
  resolveInputs,
  runCredentialPreflightForInputs,
  runOnboarding,
  validateApiKey,
  type Reporter
} from './index.js';
import { sleep } from './lib/retry.js';
import { getMemoizedSessionIdentity } from './lib/credential-identity.js';
import { normalizedInputEnvName, runnerInputEnvName } from './lib/input.js';
import { createTelemetryContext } from '@postman-cse/automation-telemetry-core';
import { resolveActionVersion } from './action-version.js';

const INPUT_NAMES = [
  'project-name',
  'workspace-id',
  'environment-id',
  'system-environment-id',
  'cluster-name',
  'repo-url',
  'postman-access-token',
  'postman-api-key',
  'create-api-key',
  'credential-preflight',
  'service-not-found-policy',
  'postman-team-id',
  'github-token',
  'poll-timeout-seconds',
  'poll-interval-seconds',
  'postman-region',
  'postman-stack'
] as const;

const OUTPUT_OPTION_NAMES = ['result-json', 'dotenv-path'] as const;

interface CliRunConfig {
  kind: 'run';
  inputEnv: NodeJS.ProcessEnv;
  resultJsonPath?: string;
  dotenvPath?: string;
}

export type ParsedCliArgs =
  | { kind: 'help' }
  | { kind: 'version' }
  | CliRunConfig;

export interface CliRuntime {
  env?: NodeJS.ProcessEnv;
  executeOnboarding?: typeof runOnboarding;
  writeStdout?: (chunk: string) => void;
}

export class ConsoleReporter implements Reporter {
  private readonly secretValues: string[] = [];

  public info(message: string): void {
    console.error(this.mask(message));
  }

  public warning(message: string): void {
    console.error(`WARNING: ${this.mask(message)}`);
  }

  public setSecret(value: string): void {
    if (value) {
      this.secretValues.push(value);
    }
  }

  private mask(message: string): string {
    let masked = message;
    for (const secret of this.secretValues) {
      masked = masked.replaceAll(secret, '***');
    }
    return masked;
  }
}

export function normalizeCliFlag(name: string): string {
  return normalizedInputEnvName(name);
}

function resolvePackageVersion(): string {
  const candidates: string[] = [];
  if (typeof __filename === 'string') {
    // Present in the esbuild CJS bundle (dist/cli.cjs -> ../package.json).
    candidates.push(path.join(path.dirname(__filename), '..', 'package.json'));
  }
  // vitest/ESM and local smoke: package.json at cwd.
  candidates.push(path.join(process.cwd(), 'package.json'));

  for (const candidate of candidates) {
    try {
      const packageJson = JSON.parse(readFileSync(candidate, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (packageJson.name === '@postman-cse/onboarding-insights' && packageJson.version) {
        return String(packageJson.version).trim();
      }
    } catch {
      // try next candidate
    }
  }
  return resolveActionVersion();
}

function renderHelp(): string {
  const inputFlags = INPUT_NAMES.map((name) => `  --${name} <value>`).join('\n');
  return [
    'Usage: postman-insights-onboard [options]',
    '',
    'Options:',
    inputFlags,
    '  --result-json <path>   Optional JSON output file (opt-in)',
    '  --dotenv-path <path>   Optional dotenv output file',
    '  --help                 Show this help and exit',
    '  --version              Print version and exit',
    ''
  ].join('\n');
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedCliArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { kind: 'help' };
  }
  if (argv.includes('--version') || argv.includes('-V')) {
    return { kind: 'version' };
  }

  const allowed = new Set<string>([...INPUT_NAMES, ...OUTPUT_OPTION_NAMES]);
  const seen = new Set<string>();
  const inputEnv: NodeJS.ProcessEnv = { ...env };
  let resultJsonPath: string | undefined;
  let dotenvPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const equalsIndex = arg.indexOf('=');
    const name = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
    if (!allowed.has(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate option: --${name}`);
    }

    let value: string | undefined;
    if (equalsIndex >= 0) {
      value = arg.slice(equalsIndex + 1);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Missing value for --${name}`);
      }
      value = next;
      index += 1;
    }
    if (value.length === 0) {
      throw new Error(`Missing value for --${name}`);
    }

    seen.add(name);
    if (name === 'result-json') {
      resultJsonPath = value;
      continue;
    }
    if (name === 'dotenv-path') {
      dotenvPath = value;
      continue;
    }
    const normalizedName = normalizedInputEnvName(name);
    delete inputEnv[runnerInputEnvName(name)];
    delete inputEnv[normalizedName];
    inputEnv[normalizedName] = value;
  }

  return {
    kind: 'run',
    inputEnv,
    resultJsonPath,
    dotenvPath
  };
}

export function toDotenv(outputs: Record<string, string>): string {
  return Object.entries(outputs)
    .map(([key, value]) => [
      `POSTMAN_INSIGHTS_${key.replace(/-/g, '_').toUpperCase()}`,
      value
    ] as const)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n');
}

function assertWithinWorkspace(workspaceRoot: string, resolved: string, filePath: string): void {
  const relative = path.relative(workspaceRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Output path must stay within workspace: ${filePath}`);
  }
}

async function findExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

async function validateOutputPath(filePath: string | undefined): Promise<void> {
  if (!filePath) {
    return;
  }
  const workspaceRoot = await realpath(process.cwd());
  const resolved = path.resolve(workspaceRoot, filePath);
  assertWithinWorkspace(workspaceRoot, resolved, filePath);
  const existingParent = await findExistingAncestor(path.dirname(resolved));
  assertWithinWorkspace(workspaceRoot, existingParent, filePath);
}

async function writeAtomicFile(filePath: string, content: string): Promise<void> {
  const workspaceRoot = await realpath(process.cwd());
  const resolved = path.resolve(workspaceRoot, filePath);
  assertWithinWorkspace(workspaceRoot, resolved, filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const resolvedParent = await realpath(path.dirname(resolved));
  assertWithinWorkspace(workspaceRoot, resolvedParent, filePath);

  const safeTarget = path.join(resolvedParent, path.basename(resolved));
  const tempPath = path.join(
    resolvedParent,
    `.${path.basename(resolved)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(tempPath, safeTarget);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function writeOptionalFile(filePath: string | undefined, content: string): Promise<void> {
  if (!filePath) {
    return;
  }
  await writeAtomicFile(filePath, content);
}

function toOutputs(result: Awaited<ReturnType<typeof runOnboarding>>): Record<string, string> {
  return {
    'discovered-service-id': String(result.discoveredServiceId),
    'discovered-service-name': result.discoveredServiceName,
    'collection-id': result.collectionId,
    'application-id': result.applicationId,
    'verification-token': result.verificationToken ?? '',
    status: result.status
  };
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  runtime: CliRuntime = {}
): Promise<void> {
  const env = runtime.env ?? process.env;
  const writeStdout = runtime.writeStdout ?? ((chunk: string) => process.stdout.write(chunk));
  const parsed = parseCliArgs(argv, env);

  if (parsed.kind === 'help') {
    writeStdout(renderHelp());
    return;
  }
  if (parsed.kind === 'version') {
    writeStdout(`${resolvePackageVersion()}\n`);
    return;
  }

  const config = parsed;
  await validateOutputPath(config.resultJsonPath);
  await validateOutputPath(config.dotenvPath);
  const inputs = resolveInputs(config.inputEnv);

  const reporter = new ConsoleReporter();

  // PMAK-only runs: mint the access token up front (mirrors runAction) so
  // dist/cli.cjs behaves exactly like dist/index.cjs.
  const mintHolder = {
    postmanAccessToken: inputs.postmanAccessToken,
    postmanApiKey: inputs.postmanApiKey,
    postmanApiBase: inputs.postmanApiBase
  };
  await mintAccessTokenIfNeeded(mintHolder, reporter, (secret) => reporter.setSecret(secret));
  inputs.postmanAccessToken = mintHolder.postmanAccessToken;

  if (inputs.postmanAccessToken) reporter.setSecret(inputs.postmanAccessToken);
  if (inputs.postmanApiKey) {
    reporter.setSecret(inputs.postmanApiKey);
  }
  if (inputs.githubToken) {
    reporter.setSecret(inputs.githubToken);
  }

  const tokenProvider = createInsightsTokenProvider(inputs, reporter);
  const preliminaryClient = createInsightsBifrostClient(
    inputs,
    tokenProvider,
    inputs.postmanTeamId,
    inputs.postmanApiKey
  );

  const telemetry = createTelemetryContext({ action: 'postman-insights-onboarding-action', actionVersion: resolveActionVersion(), logger: reporter });
  telemetry.setTeamId(inputs.postmanTeamId);
  let result: Awaited<ReturnType<typeof runOnboarding>>;
  try {
    let preflightPmakIdentity;
    if (inputs.postmanApiKey) {
      const validated = await validateApiKey(
        inputs.postmanApiKey,
        inputs.postmanApiBase || DEFAULT_POSTMAN_API_BASE
      );
      if (validated.valid) {
        preflightPmakIdentity = { source: 'pmak/me' as const, teamId: validated.teamId };
      } else if (!inputs.createApiKey) {
        throw new Error(
          'postman-api-key is invalid or expired. Provide a valid key, or set create-api-key=true to opt in to durable Bifrost API-key creation.'
        );
      }
    } else if (!inputs.createApiKey) {
      throw new Error(
        'postman-api-key is required for application binding. Provide a valid key, or set create-api-key=true to opt in to durable Bifrost API-key creation.'
      );
    }

    await runCredentialPreflightForInputs(
      inputs,
      preflightPmakIdentity,
      reporter,
      undefined,
      tokenProvider.current()
    );

    const { apiKey, teamId, pmakIdentity } = await resolveApiKeyAndTeamId(inputs, preliminaryClient, reporter);
    telemetry.setTeamId(inputs.postmanTeamId || pmakIdentity?.teamId);
    reporter.setSecret(apiKey);

    const activeTokenProvider =
      apiKey !== inputs.postmanApiKey
        ? new AccessTokenProvider({
            accessToken: tokenProvider.current(),
            apiKey,
            apiBaseUrl: inputs.postmanApiBase || DEFAULT_POSTMAN_API_BASE,
            onToken: (token) => reporter.setSecret(token)
          })
        : tokenProvider;

    if (pmakIdentity?.teamId !== preflightPmakIdentity?.teamId) {
      await runCredentialPreflightForInputs(
        inputs,
        pmakIdentity,
        reporter,
        undefined,
        activeTokenProvider.current()
      );
    }

    const client = createInsightsBifrostClient(inputs, activeTokenProvider, teamId, apiKey);

    result = await (runtime.executeOnboarding ?? runOnboarding)(
      inputs,
      client,
      sleep,
      reporter
    );
  } catch (error) {
    telemetry.setAccountType(getMemoizedSessionIdentity()?.consumerType);
    telemetry.emitCompletion('failure');
    throw error;
  }
  telemetry.setAccountType(getMemoizedSessionIdentity()?.consumerType);
  telemetry.emitCompletion(
    result.status === 'error' || result.status === 'not-found' ? 'failure' : 'success'
  );
  const outputs = toOutputs(result);

  const jsonOutput = JSON.stringify(outputs, null, 2);
  await writeOptionalFile(config.resultJsonPath, jsonOutput);
  await writeOptionalFile(config.dotenvPath, toDotenv(outputs));

  writeStdout(`${jsonOutput}\n`);
}

const currentModulePath = typeof __filename === 'string' ? __filename : '';
const entrypoint = process.argv[1];

function isEntrypoint(currentPath: string, entrypointPath: string | undefined): boolean {
  if (!currentPath || !entrypointPath) {
    return false;
  }
  try {
    return realpathSync(currentPath) === realpathSync(entrypointPath);
  } catch {
    return path.resolve(currentPath) === path.resolve(entrypointPath);
  }
}

if (isEntrypoint(currentModulePath, entrypoint)) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
