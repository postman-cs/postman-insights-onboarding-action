import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  resolveApiKeyAndTeamId,
  resolveInputs,
  runOnboarding,
  type Reporter
} from './index.js';
import { BifrostCatalogClient } from './lib/bifrost-client.js';
import { sleep } from './lib/retry.js';
import { createSecretMasker } from './lib/secrets.js';

interface CliConfig {
  inputEnv: NodeJS.ProcessEnv;
  resultJsonPath: string;
  dotenvPath?: string;
}

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

function readFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === `--${name}`) {
      return argv[index + 1];
    }
    if (arg?.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
}

export function normalizeCliFlag(name: string): string {
  return `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliConfig {
  const inputNames = [
    'project-name',
    'workspace-id',
    'environment-id',
    'system-environment-id',
    'cluster-name',
    'git-owner',
    'git-repository-name',
    'repo-url',
    'postman-access-token',
    'postman-api-key',
    'postman-team-id',
    'github-token',
    'poll-timeout-seconds',
    'poll-interval-seconds'
  ];

  const inputEnv: NodeJS.ProcessEnv = { ...env };
  for (const name of inputNames) {
    const value = readFlag(argv, name);
    if (value !== undefined) {
      inputEnv[normalizeCliFlag(name)] = value;
    }
  }

  return {
    inputEnv,
    resultJsonPath: readFlag(argv, 'result-json') ?? 'postman-insights-onboarding-result.json',
    dotenvPath: readFlag(argv, 'dotenv-path')
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

async function writeOptionalFile(filePath: string | undefined, content: string): Promise<void> {
  if (!filePath) {
    return;
  }
  const workspaceRoot = path.resolve(process.cwd());
  const resolved = path.resolve(workspaceRoot, filePath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Output path must stay within workspace: ${filePath}`);
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, content, 'utf8');
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
  const config = parseCliArgs(argv, env);
  const inputs = resolveInputs(config.inputEnv);

  const reporter = new ConsoleReporter();
  reporter.setSecret(inputs.postmanAccessToken);
  if (inputs.postmanApiKey) {
    reporter.setSecret(inputs.postmanApiKey);
  }
  if (inputs.githubToken) {
    reporter.setSecret(inputs.githubToken);
  }

  const preliminaryMaskSecret = createSecretMasker([
    inputs.postmanAccessToken,
    inputs.postmanApiKey,
    inputs.githubToken
  ]);
  const preliminaryClient = new BifrostCatalogClient({
    accessToken: inputs.postmanAccessToken,
    teamId: inputs.postmanTeamId,
    apiKey: inputs.postmanApiKey,
    maskSecret: preliminaryMaskSecret
  });

  const { apiKey, teamId } = await resolveApiKeyAndTeamId(inputs, preliminaryClient, reporter);
  if (apiKey) {
    reporter.setSecret(apiKey);
  }

  const maskSecret = createSecretMasker([
    inputs.postmanAccessToken,
    inputs.githubToken,
    apiKey
  ]);
  const client = new BifrostCatalogClient({
    accessToken: inputs.postmanAccessToken,
    teamId,
    apiKey,
    maskSecret
  });

  const result = await (runtime.executeOnboarding ?? runOnboarding)(
    inputs,
    client,
    sleep,
    reporter
  );
  const outputs = toOutputs(result);

  const jsonOutput = JSON.stringify(outputs, null, 2);
  await writeOptionalFile(config.resultJsonPath, jsonOutput);
  await writeOptionalFile(config.dotenvPath, toDotenv(outputs));

  const writeStdout = runtime.writeStdout ?? ((chunk: string) => process.stdout.write(chunk));
  writeStdout(`${jsonOutput}\n`);
}

const currentModulePath = typeof __filename === 'string' ? __filename : '';
const entrypoint = process.argv[1];

if (entrypoint && currentModulePath === entrypoint) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
