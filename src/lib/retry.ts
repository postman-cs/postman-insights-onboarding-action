export interface RetryDecisionContext {
  attempt: number;
  maxAttempts: number;
}

export interface RetryContext extends RetryDecisionContext {
  delayMs: number;
  error: unknown;
}

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown, context: RetryDecisionContext) => boolean;
  onRetry?: (context: RetryContext) => void | Promise<void>;
  sleep?: (delayMs: number) => Promise<void>;
}

export function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function normalizeRetryOptions(
  retriesOrOptions: number | RetryOptions,
  delayMs?: number
): Required<RetryOptions> {
  if (typeof retriesOrOptions === 'number') {
    return {
      maxAttempts: Math.max(1, retriesOrOptions),
      delayMs: Math.max(0, delayMs ?? 2000),
      backoffMultiplier: 1,
      maxDelayMs: Number.POSITIVE_INFINITY,
      shouldRetry: () => true,
      onRetry: async () => undefined,
      sleep
    };
  }
  return {
    maxAttempts: Math.max(1, retriesOrOptions.maxAttempts ?? 3),
    delayMs: Math.max(0, retriesOrOptions.delayMs ?? 2000),
    backoffMultiplier: Math.max(1, retriesOrOptions.backoffMultiplier ?? 1),
    maxDelayMs:
      retriesOrOptions.maxDelayMs === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, retriesOrOptions.maxDelayMs),
    shouldRetry: retriesOrOptions.shouldRetry ?? (() => true),
    onRetry: retriesOrOptions.onRetry ?? (async () => undefined),
    sleep: retriesOrOptions.sleep ?? sleep
  };
}

export async function retry<T>(
  operation: () => Promise<T>,
  retriesOrOptions: number | RetryOptions = {},
  delayMs?: number
): Promise<T> {
  const options = normalizeRetryOptions(retriesOrOptions, delayMs);
  let nextDelayMs = options.delayMs;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const canRetry =
        attempt < options.maxAttempts &&
        options.shouldRetry(error, { attempt, maxAttempts: options.maxAttempts });
      if (!canRetry) throw error;
      await options.onRetry({
        attempt,
        maxAttempts: options.maxAttempts,
        delayMs: nextDelayMs,
        error
      });
      await options.sleep(nextDelayMs);
      nextDelayMs = Math.min(
        options.maxDelayMs,
        Math.round(nextDelayMs * options.backoffMultiplier)
      );
    }
  }
  throw new Error('Retry exhausted without returning or throwing');
}
