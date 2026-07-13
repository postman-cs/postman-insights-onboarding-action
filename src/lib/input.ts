export function normalizeInputValue(value: string | undefined): string {
  return String(value ?? '').trim();
}

export function runnerInputEnvName(name: string): string {
  // Matches @actions/core getInput: spaces become underscores, hyphens stay.
  return `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
}

export function normalizedInputEnvName(name: string): string {
  // CLI and historical local callers normalize hyphens to underscores.
  return `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
}

/**
 * Shared Action/CLI input adapter.
 *
 * Resolves both:
 * - GitHub runner form: INPUT_FOO-BAR (what @actions/core getInput reads)
 * - CLI-normalized form: INPUT_FOO_BAR
 *
 * Matching values are accepted. Conflicting non-empty values fail closed.
 * When both are present and equal, either form is fine; the normalized form is
 * returned for stable downstream consumption.
 */
export function getInput(
  name: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): string {
  const normalizedName = normalizedInputEnvName(name);
  const runnerName = runnerInputEnvName(name);
  const normalizedRaw = env[normalizedName];
  const runnerRaw = runnerName === normalizedName ? undefined : env[runnerName];
  const hasNormalized = normalizedRaw !== undefined;
  const hasRunner = runnerRaw !== undefined;

  if (hasNormalized && hasRunner) {
    const normalizedValue = normalizeInputValue(normalizedRaw);
    const runnerValue = normalizeInputValue(runnerRaw);
    if (normalizedValue !== runnerValue) {
      throw new Error(
        `Conflicting values for ${name}: ${normalizedName}=${JSON.stringify(normalizedValue)} vs ${runnerName}=${JSON.stringify(runnerValue)}`
      );
    }
  }

  return normalizeInputValue(hasNormalized ? normalizedRaw : runnerRaw);
}
