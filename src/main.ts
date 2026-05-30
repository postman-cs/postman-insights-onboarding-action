import * as core from '@actions/core';

import { runAction } from './index.js';

runAction().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  core.setOutput('status', 'error');
  core.setFailed(message);
  process.exitCode = 1;
});
