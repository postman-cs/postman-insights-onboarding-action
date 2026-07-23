import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  insightsActionContract,
  contractInputNames,
  contractOutputNames
} from '../src/contracts.js';
import { assertWritingInputs, resolveInputs, createPlannedOutputs } from '../src/index.js';
import { parsePostmanRegion, parsePostmanStack } from '../src/lib/postman/base-urls.js';

const repoRoot = resolve(import.meta.dirname, '..');
const actionManifest = parse(
  readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')
) as {
  name: string;
  inputs: Record<string, { required?: boolean; default?: string }>;
  outputs: Record<string, unknown>;
  runs: { using: string; main: string };
};
const packageManifest = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8')
) as {
  main: string;
  scripts: {
    build: string;
    bundle?: string;
    'verify:dist'?: string;
    'verify:dist:assert'?: string;
  };
};
const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
const credentialsDoc = readFileSync(resolve(repoRoot, 'docs/credentials.md'), 'utf8');
const contractSmokeWorkflow = readFileSync(
  resolve(repoRoot, '.github/workflows/contract-smoke.yml'),
  'utf8'
);

describe('action contract', () => {
  it('action.yml name matches contract name', () => {
    expect(actionManifest.name).toBe(insightsActionContract.name);
  });

  it('uses kebab-case input and output names', () => {
    const kebabCasePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    for (const name of [...contractInputNames, ...contractOutputNames]) {
      expect(name).toMatch(kebabCasePattern);
    }
  });

  it('keeps action.yml aligned with the contract surface', () => {
    expect(Object.keys(actionManifest.inputs)).toEqual(contractInputNames);
    expect(Object.keys(actionManifest.outputs)).toEqual(contractOutputNames);
  });

  it('keeps package imports separate from the GitHub Actions runner bundle', () => {
    expect(actionManifest.runs).toEqual({
      using: 'node24',
      main: 'dist/action.cjs'
    });
    expect(packageManifest.main).toBe('dist/index.cjs');
    expect(packageManifest.scripts.bundle).toContain('src/index.ts --bundle');
    expect(packageManifest.scripts.bundle).toContain('--outfile=dist/index.cjs');
    expect(packageManifest.scripts.bundle).toContain('src/main.ts --bundle');
    expect(packageManifest.scripts.bundle).toContain('--outfile=dist/action.cjs');
    expect(packageManifest.scripts.bundle).toContain('--banner:js="#!/usr/bin/env node"');
    expect(packageManifest.scripts.bundle).toContain("process.platform!=='win32'");
    expect(packageManifest.scripts.bundle).toContain("chmodSync('dist/cli.cjs',0o755)");
    expect(packageManifest.scripts.build).toMatch(/typecheck.*&&.*bundle|bundle.*typecheck/);
    expect(packageManifest.scripts['verify:dist:assert']).toBe(
      'git diff --ignore-space-at-eol --text --exit-code -- dist && node scripts/verify-dist-artifact.mjs'
    );
    expect(packageManifest.scripts['verify:dist']).toBe('npm run build && npm run verify:dist:assert');
  });

  it('keeps postman-stack compatible while documenting postman-region for data residency', () => {
    expect(insightsActionContract.inputs['postman-stack'].default).toBe('prod');
    expect(insightsActionContract.inputs['postman-stack'].allowedValues).toEqual(['prod', 'beta']);
    expect(insightsActionContract.inputs['postman-region'].default).toBe('us');
    expect(insightsActionContract.inputs['postman-region'].allowedValues).toEqual(['us', 'eu']);
    expect(actionManifest.inputs['postman-stack'].default).toBe('prod');
    expect(actionManifest.inputs['postman-region'].default).toBe('us');
    expect(String((actionManifest.inputs['postman-stack'] as { description?: string }).description)).not.toMatch(/beta|getpostman-beta/i);
    expect(readme).not.toContain('`postman-stack`');
    expect(readme).toContain('Choose the Postman data residency region up front with `postman-region`');
    expect(String((actionManifest.inputs['postman-region'] as { description?: string }).description)).toContain('us or eu');
  });

  it('marks project-name, workspace-id, environment-id as required (postman-access-token is mintable from postman-api-key)', () => {
    const requiredInputs = Object.entries(insightsActionContract.inputs)
      .filter(([, v]) => v.required)
      .map(([k]) => k);
    expect(requiredInputs).toEqual([
      'project-name',
      'workspace-id',
      'environment-id',
    ]);
  });

  it('marks postman-api-key as optional', () => {
    expect(insightsActionContract.inputs['postman-api-key'].required).toBe(false);
    expect(actionManifest.inputs['postman-api-key'].required).toBe(false);
  });

  it('defaults credential-preflight to enforce with enforce/warn allowed', () => {
    const contractInput = insightsActionContract.inputs['credential-preflight'];
    expect(contractInput.required).toBe(false);
    expect(contractInput.default).toBe('enforce');
    expect(contractInput.allowedValues).toEqual(['enforce', 'warn']);
    expect(actionManifest.inputs['credential-preflight'].required).toBe(false);
    expect(actionManifest.inputs['credential-preflight'].default).toBe('enforce');
  });

  it('threads credential-preflight and the iapub base through resolveInputs with an enforce default', () => {
    const base = {
      INPUT_PROJECT_NAME: 'svc',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_ENVIRONMENT_ID: 'env-456',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok-abc',
    };
    expect(resolveInputs(base).credentialPreflight).toBe('enforce');
    expect(resolveInputs(base).postmanIapubBase).toBe('https://iapub.postman.co');
    expect(
      resolveInputs({ ...base, INPUT_CREDENTIAL_PREFLIGHT: 'enforce' }).credentialPreflight
    ).toBe('enforce');
    expect(() =>
      resolveInputs({ ...base, INPUT_CREDENTIAL_PREFLIGHT: 'off' })
    ).toThrow(/Unsupported credential-preflight/);
    expect(() =>
      resolveInputs({ ...base, INPUT_CREDENTIAL_PREFLIGHT: 'strict' })
    ).toThrow(/Unsupported credential-preflight/);

    const eu = resolveInputs({ ...base, INPUT_POSTMAN_REGION: 'eu' });
    expect(eu.postmanRegion).toBe('eu');
    expect(eu.postmanApiBase).toBe('https://api.eu.postman.com');
  });

  it('defaults poll-timeout-seconds to 120 and poll-interval-seconds to 10', () => {
    expect(insightsActionContract.inputs['poll-timeout-seconds'].default).toBe('120');
    expect(insightsActionContract.inputs['poll-interval-seconds'].default).toBe('10');
    expect(actionManifest.inputs['poll-timeout-seconds'].default).toBe('120');
    expect(actionManifest.inputs['poll-interval-seconds'].default).toBe('10');
  });

  it('throws when required inputs are missing', () => {
    expect(() => resolveInputs({})).toThrow('project-name is required');
    expect(() => assertWritingInputs(resolveInputs({
      INPUT_PROJECT_NAME: 'svc', INPUT_WORKSPACE_ID: 'ws-123', INPUT_ENVIRONMENT_ID: 'env-456'
    }))).toThrow('human-user PMAK and a human-user session access token');
    // Insights requires both explicit human-user credentials and never mints a session token.
    expect(() =>
      assertWritingInputs(resolveInputs({
        INPUT_PROJECT_NAME: 'svc',
        INPUT_WORKSPACE_ID: 'ws-123',
        INPUT_ENVIRONMENT_ID: 'env-456',
        INPUT_POSTMAN_API_KEY: 'PMAK-svc',
      }))
    ).toThrow('human-user PMAK and a human-user session access token');
  });

  it('retains an omitted postman-api-key for the write guard to reject before writes', () => {
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'svc',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_ENVIRONMENT_ID: 'env-456',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok-abc',
      INPUT_POSTMAN_TEAM_ID: '14103640',
    });
    expect(inputs.postmanApiKey).toBe('');
  });

  it('selects beta endpoint profile from postman-stack', () => {
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'svc',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_ENVIRONMENT_ID: 'env-456',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok-abc',
      INPUT_POSTMAN_STACK: 'beta',
      INPUT_POSTMAN_API_BASE: 'https://override.example.com',
      INPUT_POSTMAN_BIFROST_BASE: 'https://override.example.com',
      INPUT_POSTMAN_OBSERVABILITY_BASE: 'https://override.example.com',
    });

    expect(inputs.postmanStack).toBe('beta');
    expect(inputs.postmanApiBase).toBe('https://api.getpostman-beta.com');
    expect(inputs.postmanBifrostBase).toBe('https://bifrost-https-v4.gw.postman-beta.com');
    expect(inputs.postmanObservabilityBase).toBe('https://api.observability.postman-beta.com');
    expect(inputs.postmanObservabilityEnv).toBe('beta');
    expect(() =>
      resolveInputs({
        INPUT_PROJECT_NAME: 'svc',
        INPUT_WORKSPACE_ID: 'ws-123',
        INPUT_ENVIRONMENT_ID: 'env-456',
        INPUT_POSTMAN_ACCESS_TOKEN: 'tok-abc',
        INPUT_POSTMAN_STACK: 'stage',
      })
    ).toThrow(/Unsupported postman-stack/);
  });

  it('keeps multiline invalid region/stack errors one line and lists supported values', () => {
    try {
      parsePostmanRegion('eu\ninjected');
      expect.fail('expected parsePostmanRegion to throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toMatch(/[\r\n]/);
      expect(message).toMatch(/Unsupported postman-region/);
      expect(message).toContain('Supported values: us, eu');
    }
    try {
      parsePostmanStack('beta\rinjected');
      expect.fail('expected parsePostmanStack to throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toMatch(/[\r\n]/);
      expect(message).toMatch(/Unsupported postman-stack/);
      expect(message).toContain('Supported values: prod, beta');
    }
  });

  it('auto-detects repo-url from CI context when the input is omitted', () => {
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'svc',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_ENVIRONMENT_ID: 'env-456',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok-abc',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'postman-cs/repo-a'
    });

    expect(inputs.repoUrl).toBe('https://github.com/postman-cs/repo-a');
  });

  it('reads POSTMAN_TEAM_ID from env when postman-team-id input is empty', () => {
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'svc',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_ENVIRONMENT_ID: 'env-456',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok-abc',
      POSTMAN_TEAM_ID: '99999',
    });
    expect(inputs.postmanTeamId).toBe('99999');
  });

  it('prefers postman-team-id input over POSTMAN_TEAM_ID env', () => {
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'svc',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_ENVIRONMENT_ID: 'env-456',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok-abc',
      INPUT_POSTMAN_TEAM_ID: '11111',
      POSTMAN_TEAM_ID: '22222',
    });
    expect(inputs.postmanTeamId).toBe('11111');
  });

  it('builds planned outputs with cluster-prefixed service name', () => {
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'af-cards-3ds',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_ENVIRONMENT_ID: 'env-456',
      INPUT_CLUSTER_NAME: 'se-catalog-demo',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok-abc',
      INPUT_POSTMAN_API_KEY: 'PMAK-test',
      INPUT_POSTMAN_TEAM_ID: '14103640',
    });
    const outputs = createPlannedOutputs(inputs);
    expect(outputs['discovered-service-name']).toBe('se-catalog-demo/af-cards-3ds');
    expect(outputs.status).toBe('pending');
  });

  it('clamps poll-timeout-seconds to bounds [10, 600]', () => {
    const tooLow = resolveInputs({
      INPUT_PROJECT_NAME: 'svc',
      INPUT_WORKSPACE_ID: 'ws',
      INPUT_ENVIRONMENT_ID: 'env',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok',
      INPUT_POLL_TIMEOUT_SECONDS: '1',
    });
    expect(tooLow.pollTimeoutSeconds).toBe(10);

    const tooHigh = resolveInputs({
      INPUT_PROJECT_NAME: 'svc',
      INPUT_WORKSPACE_ID: 'ws',
      INPUT_ENVIRONMENT_ID: 'env',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok',
      INPUT_POLL_TIMEOUT_SECONDS: '9999',
    });
    expect(tooHigh.pollTimeoutSeconds).toBe(600);
  });

  it('clamps poll-interval-seconds to bounds [2, 60]', () => {
    const tooLow = resolveInputs({
      INPUT_PROJECT_NAME: 'svc',
      INPUT_WORKSPACE_ID: 'ws',
      INPUT_ENVIRONMENT_ID: 'env',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok',
      INPUT_POLL_INTERVAL_SECONDS: '0',
    });
    expect(tooLow.pollIntervalSeconds).toBe(2);

    const tooHigh = resolveInputs({
      INPUT_PROJECT_NAME: 'svc',
      INPUT_WORKSPACE_ID: 'ws',
      INPUT_ENVIRONMENT_ID: 'env',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok',
      INPUT_POLL_INTERVAL_SECONDS: '120',
    });
    expect(tooHigh.pollIntervalSeconds).toBe(60);
  });

  it('uses default when poll values are non-numeric', () => {
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'svc',
      INPUT_WORKSPACE_ID: 'ws',
      INPUT_ENVIRONMENT_ID: 'env',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok',
      INPUT_POLL_TIMEOUT_SECONDS: 'abc',
      INPUT_POLL_INTERVAL_SECONDS: 'xyz',
    });
    expect(inputs.pollTimeoutSeconds).toBe(120);
    expect(inputs.pollIntervalSeconds).toBe(10);
  });
});

describe('marketplace readiness docs', () => {
  it('keeps prerequisites, action boundaries, human-user credentials, and region visible before examples', () => {
    const firstExampleIndex = readme.indexOf('## Examples');
    const firstExampleIntro = readme.slice(0, firstExampleIndex);
    const humanCredentialIndex = readme.indexOf('human-user PMAK');
    const insightsIndex = readme.indexOf('postman-insights-onboarding-action@v2');
    const regionIndex = readme.indexOf('postman-region: us');

    expect(firstExampleIntro).toContain('does **not** deploy the Insights agent');
    expect(firstExampleIntro).toContain('action-picker table');
    expect(humanCredentialIndex).toBeGreaterThan(-1);
    expect(insightsIndex).toBeGreaterThan(-1);
    expect(humanCredentialIndex).toBeLessThan(insightsIndex);
    expect(regionIndex).toBeGreaterThan(-1);
    expect(regionIndex).toBeLessThan(firstExampleIndex);
    expect(readme).toContain(
      'https://raw.githubusercontent.com/postman-cs/postman-insights-onboarding-action/main/examples/core-payments-openapi.yaml'
    );
  });

  it('documents human-user credentials without preview wording or a public off mode', () => {
    expect(credentialsDoc).toContain('human-user PMAK');
    expect(credentialsDoc).toContain('consumerType=user');
    expect(credentialsDoc).toContain('does not mint or refresh');
    expect(credentialsDoc).not.toContain('Customer Preview');
    expect(credentialsDoc).not.toContain('off: skips');
    expect(readme).not.toContain('credential-preflight: off');
    expect(readme).not.toContain('off skips the identity probes');
  });

  it('ships support, security, and release policy files', () => {
    expect(existsSync(resolve(repoRoot, 'SUPPORT.md'))).toBe(true);
    expect(existsSync(resolve(repoRoot, 'SECURITY.md'))).toBe(true);
    expect(existsSync(resolve(repoRoot, 'RELEASE_POLICY.md'))).toBe(true);
  });

  it('keeps scheduled contract smoke behind an explicit secret skip gate', () => {
    expect(contractSmokeWorkflow).toContain('run_smoke');
    expect(contractSmokeWorkflow).toContain('Skipping Insights contract smoke');
    expect(contractSmokeWorkflow).toContain('### Insights contract smoke');
    expect(contractSmokeWorkflow).toContain('needs.preflight.outputs.run_smoke');
    expect(contractSmokeWorkflow).toContain('if [ "$GITHUB_EVENT_NAME" = "schedule" ]; then');
    expect(contractSmokeWorkflow).toContain('::error::Cannot run Insights contract smoke');
    expect(contractSmokeWorkflow).toContain('if [ "$missing_required" = "true" ]; then');
  });
});
