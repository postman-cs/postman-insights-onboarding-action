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
    ).toThrow(/Conflicting values for project-name/);
  });

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
