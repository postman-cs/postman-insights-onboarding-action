import { describe, expect, it, vi } from 'vitest';
import { createLogger, type LogSink } from '@postman-cse/automation-core';

import { runAction } from '../src/index.js';

/**
 * A log line is evidence. These tests pin the properties that make it worth
 * trusting: credentials never survive into it, a failure names the phase it
 * died in, and debug output is opt-in rather than always-on.
 */

function recordingSink(): { sink: LogSink; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      debug: (message) => lines.push(`debug ${message}`),
      info: (message) => lines.push(`info ${message}`),
      warning: (message) => lines.push(`warning ${message}`),
      error: (message) => lines.push(`error ${message}`)
    }
  };
}

const PMAK = 'PMAK-insightstestkey-0123456789';

function withEnv<T>(overrides: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const previous: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// Insights writes require a human-user PMAK and a human-user session access
// token; neither can be minted from the other, so both are supplied here.
const REQUIRED: NodeJS.ProcessEnv = {
  INPUT_PROJECT_NAME: 'payments',
  INPUT_WORKSPACE_ID: 'ws-1',
  INPUT_POSTMAN_API_KEY: PMAK,
  INPUT_POSTMAN_ACCESS_TOKEN: 'pma_at_humansession',
  INPUT_ENVIRONMENT_ID: 'env-1',
  INPUT_POSTMAN_TEAM_ID: '10490519'
};

describe('insights-onboarding logging', () => {
  it('never emits the credential it was handed, even when upstream echoes it back', async () => {
    // An upstream that reflects the credential back must not turn a diagnostic
    // line into a leak.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(`{"message":"rejected ${PMAK}"}`, { status: 401 }))
    );
    const { sink, lines } = recordingSink();

    await withEnv(REQUIRED, async () => {
      await runAction(createLogger({ sink, level: 'debug' }));
    });

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(PMAK);
    vi.unstubAllGlobals();
  });

  it('names the phase that failed, which setFailed alone would not', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const { sink, lines } = recordingSink();

    await withEnv(REQUIRED, async () => {
      await runAction(createLogger({ sink, level: 'debug' }));
    });

    const all = lines.join('\n');
    expect(all).toContain('phase=');
    expect(all).toContain('phase failed');
    vi.unstubAllGlobals();
  });

  it('keeps debug chatter out of a default run and opens it under RUNNER_DEBUG', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    async function run(env: NodeJS.ProcessEnv): Promise<string[]> {
      const { sink, lines } = recordingSink();
      await withEnv(REQUIRED, async () => {
        await runAction(createLogger({ sink, env })).catch(() => undefined);
      });
      return lines;
    }

    expect((await run({})).filter((line) => line.startsWith('debug'))).toHaveLength(0);
    expect(
      (await run({ RUNNER_DEBUG: '1' })).filter((line) => line.startsWith('debug')).length
    ).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});
