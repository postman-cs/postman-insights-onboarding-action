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
  inputs: Record<string, { required?: boolean; default?: string }>;
  outputs: Record<string, unknown>;
};

describe('alpha action contract', () => {
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

  it('marks project-name, workspace-id, environment-id, postman-access-token, postman-team-id, postman-api-key as required', () => {
    const requiredInputs = Object.entries(alphaActionContract.inputs)
      .filter(([, v]) => v.required)
      .map(([k]) => k);
    expect(requiredInputs).toEqual([
      'project-name',
      'workspace-id',
      'environment-id',
      'postman-access-token',
      'postman-team-id',
      'postman-api-key',
    ]);
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
});
