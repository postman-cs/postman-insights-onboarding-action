import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  alphaActionContract,
  contractInputNames,
  contractOutputNames
} from '../src/contracts.js';
import { resolveInputs, createPlannedOutputs } from '../src/index.js';

const repoRoot = resolve(import.meta.dirname, '..');
const actionManifest = parse(
  readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')
) as {
  name: string;
  inputs: Record<string, { required?: boolean; default?: string }>;
  outputs: Record<string, unknown>;
};

describe('alpha action contract', () => {
  it('action.yml name matches contract name', () => {
    expect(actionManifest.name).toBe(alphaActionContract.name);
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

  it('marks project-name, workspace-id, environment-id, postman-access-token as required', () => {
    const requiredInputs = Object.entries(alphaActionContract.inputs)
      .filter(([, v]) => v.required)
      .map(([k]) => k);
    expect(requiredInputs).toEqual([
      'project-name',
      'workspace-id',
      'environment-id',
      'postman-access-token',
    ]);
  });

  it('marks postman-api-key as optional', () => {
    expect(alphaActionContract.inputs['postman-api-key'].required).toBe(false);
    expect(actionManifest.inputs['postman-api-key'].required).toBe(false);
  });

  it('defaults poll-timeout-seconds to 120 and poll-interval-seconds to 10', () => {
    expect(alphaActionContract.inputs['poll-timeout-seconds'].default).toBe('120');
    expect(alphaActionContract.inputs['poll-interval-seconds'].default).toBe('10');
    expect(actionManifest.inputs['poll-timeout-seconds'].default).toBe('120');
    expect(actionManifest.inputs['poll-interval-seconds'].default).toBe('10');
  });

  it('throws when required inputs are missing', () => {
    expect(() => resolveInputs({})).toThrow('project-name is required');
    expect(() =>
      resolveInputs({ INPUT_PROJECT_NAME: 'svc' })
    ).toThrow('postman-access-token is required');
  });

  it('does not throw when postman-api-key is omitted', () => {
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'svc',
      INPUT_WORKSPACE_ID: 'ws-123',
      INPUT_ENVIRONMENT_ID: 'env-456',
      INPUT_POSTMAN_ACCESS_TOKEN: 'tok-abc',
      INPUT_POSTMAN_TEAM_ID: '14103640',
    });
    expect(inputs.postmanApiKey).toBe('');
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
