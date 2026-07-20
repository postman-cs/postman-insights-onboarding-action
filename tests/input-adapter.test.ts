import * as core from '@actions/core';
import { afterEach, describe, expect, it } from 'vitest';

import { getInput, resolveInputs } from '../src/index.js';

const BASE = {
  INPUT_WORKSPACE_ID: 'ws-123',
  INPUT_ENVIRONMENT_ID: 'env-456',
  INPUT_POSTMAN_ACCESS_TOKEN: 'tok-abc'
} as const;

describe('shared Action/CLI input adapter', () => {
  const previousRunner = process.env['INPUT_PROJECT-NAME'];
  const previousNormalized = process.env.INPUT_PROJECT_NAME;

  afterEach(() => {
    if (previousRunner === undefined) {
      delete process.env['INPUT_PROJECT-NAME'];
    } else {
      process.env['INPUT_PROJECT-NAME'] = previousRunner;
    }
    if (previousNormalized === undefined) {
      delete process.env.INPUT_PROJECT_NAME;
    } else {
      process.env.INPUT_PROJECT_NAME = previousNormalized;
    }
  });

  it('reads the GitHub runner-form key the same way @actions/core getInput does', () => {
    delete process.env.INPUT_PROJECT_NAME;
    process.env['INPUT_PROJECT-NAME'] = 'from-runner';

    expect(core.getInput('project-name')).toBe('from-runner');
    expect(getInput('project-name', process.env)).toBe('from-runner');
  });

  it('reads the CLI-normalized underscore form when the runner form is absent', () => {
    delete process.env['INPUT_PROJECT-NAME'];
    process.env.INPUT_PROJECT_NAME = 'from-normalized';

    expect(core.getInput('project-name')).toBe('');
    expect(getInput('project-name', process.env)).toBe('from-normalized');
  });

  it('accepts matching runner-form and normalized aliases', () => {
    expect(
      getInput('project-name', {
        'INPUT_PROJECT-NAME': 'same',
        INPUT_PROJECT_NAME: 'same'
      } as NodeJS.ProcessEnv)
    ).toBe('same');
  });

  it('rejects conflicting runner-form and normalized INPUT values', () => {
    expect(() =>
      getInput('project-name', {
        'INPUT_PROJECT-NAME': 'runner',
        INPUT_PROJECT_NAME: 'normalized'
      } as NodeJS.ProcessEnv)
    ).toThrow(
      /Conflicting values for project-name: INPUT_PROJECT_NAME and INPUT_PROJECT-NAME differ\. Remove one alias or make both values identical\./
    );
  });

  it.each([
    {
      name: 'postman-access-token',
      runnerKey: 'INPUT_POSTMAN-ACCESS-TOKEN',
      normalizedKey: 'INPUT_POSTMAN_ACCESS_TOKEN',
      runnerSecret: 'PMAK-runner-secret-access-token-value',
      normalizedSecret: 'PMAK-normalized-secret-access-token-value'
    },
    {
      name: 'postman-api-key',
      runnerKey: 'INPUT_POSTMAN-API-KEY',
      normalizedKey: 'INPUT_POSTMAN_API_KEY',
      runnerSecret: 'PMAK-runner-secret-api-key-value',
      normalizedSecret: 'PMAK-normalized-secret-api-key-value'
    },
    {
      name: 'github-token',
      runnerKey: 'INPUT_GITHUB-TOKEN',
      normalizedKey: 'INPUT_GITHUB_TOKEN',
      runnerSecret: 'ghp_runnerSecretGitHubTokenValue0001',
      normalizedSecret: 'ghp_normalizedSecretGitHubTokenValue02'
    }
  ] as const)(
    'rejects conflicting aliases for $name without disclosing either value',
    ({ name, runnerKey, normalizedKey, runnerSecret, normalizedSecret }) => {
      let thrown: Error | undefined;
      try {
        getInput(name, {
          [runnerKey]: runnerSecret,
          [normalizedKey]: normalizedSecret
        } as NodeJS.ProcessEnv);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = thrown!.message;
      expect(message).toContain(`Conflicting values for ${name}`);
      expect(message).toContain(normalizedKey);
      expect(message).toContain(runnerKey);
      expect(message).toContain('differ');
      expect(message).toMatch(/Remove one alias or make both values identical/);
      expect(message).not.toContain(runnerSecret);
      expect(message).not.toContain(normalizedSecret);
    }
  );

  it('lets resolveInputs consume either alias form', () => {
    expect(
      resolveInputs({
        ...BASE,
        'INPUT_PROJECT-NAME': 'svc-runner'
      } as NodeJS.ProcessEnv).projectName
    ).toBe('svc-runner');

    expect(
      resolveInputs({
        ...BASE,
        INPUT_PROJECT_NAME: 'svc-normalized'
      }).projectName
    ).toBe('svc-normalized');
  });

  it('resolves a complete environment using real runner-form keys', () => {
    const inputs = resolveInputs({
      'INPUT_PROJECT-NAME': 'svc-runner',
      'INPUT_WORKSPACE-ID': 'ws-runner',
      'INPUT_ENVIRONMENT-ID': 'env-runner',
      'INPUT_POSTMAN-ACCESS-TOKEN': 'tok-runner'
    });

    expect(inputs.projectName).toBe('svc-runner');
    expect(inputs.workspaceId).toBe('ws-runner');
    expect(inputs.environmentId).toBe('env-runner');
    expect(inputs.postmanAccessToken).toBe('tok-runner');
  });

  it('does not silently treat bare credential variables as input aliases', () => {
    expect(() =>
      resolveInputs({
        INPUT_PROJECT_NAME: 'svc',
        INPUT_WORKSPACE_ID: 'ws',
        INPUT_ENVIRONMENT_ID: 'env',
        POSTMAN_ACCESS_TOKEN: 'bare-token',
        POSTMAN_API_KEY: 'bare-key'
      })
    ).toThrow(/postman-access-token is required/);
  });

  it('fails resolveInputs when the two alias forms disagree', () => {
    expect(() =>
      resolveInputs({
        ...BASE,
        'INPUT_PROJECT-NAME': 'svc-runner',
        INPUT_PROJECT_NAME: 'svc-normalized'
      } as NodeJS.ProcessEnv)
    ).toThrow(/Conflicting values for project-name/);
  });
});
